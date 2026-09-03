import "server-only";
import type { Sql } from "postgres";
import { addDays } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { toActor } from "@/lib/auth/session";
import {
  ADDRESS_VISIBLE_BEFORE_MIN,
  can,
  canViewCustomerAddress,
} from "@/domain/auth";
import { APP_TIME_ZONE } from "@/domain/availability";
import {
  canTransition,
  isDelayed,
  isExitOverdue,
  type DispatchStatus,
} from "@/domain/dispatch-board";
import { z } from "zod";

/**
 * 配車ボード・マイページのデータ取得/更新の中核（フェーズ14 / spec 7-1・7-3・7-4）。
 *
 * Server Action 本体（actions.ts / 'use server'）から Session を受け取って動く
 * 純粋なサーバモジュール。統合テストは getDevSession を経由せず、ここへ直接
 * therapist / staff の Session を渡して検証できる。
 *
 * 個人情報の取り扱い（spec 7-3・13-3）:
 * - therapist 経路（getTherapistTimelineCore）は **顧客電話番号を一切 select しない**。
 *   顧客名は customers_therapist_view（phone 列を持たない view / 0012）経由のみ。
 * - 住所は RLS（担当 × status × 開始180分前ゲート）が行スコープを裁定し、
 *   返した住所は audit_logs (action='view', entity='address') に閲覧記録を残す。
 * - staff 経路（getDispatchBoardCore）はタップ発信用に電話番号を返してよい
 *   （spec 7-1 L692。therapist 経路とは別）。
 */

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** dateISO（Asia/Tokyo の営業日）→ [dayStart, dayEnd) の timestamptz 範囲 */
function dayBounds(dateISO: string): { dayStart: Date; dayEnd: Date } {
  if (!DATE_RE.test(dateISO)) {
    throw new RangeError(`dateISO は "YYYY-MM-DD" であること: ${dateISO}`);
  }
  const dayStart = fromZonedTime(`${dateISO}T00:00:00`, APP_TIME_ZONE);
  return { dayStart, dayEnd: addDays(dayStart, 1) };
}

// ---------------------------------------------------------------------------
// 1. ステータスを進める（spec 7-1「ワンタップで進める」）
// ---------------------------------------------------------------------------

/** 進め先（confirmed は初期値であり遷移先にならない） */
export type AdvanceTarget = Exclude<DispatchStatus, "confirmed">;

export type AdvanceOutcome =
  | { kind: "ok"; reservationId: string; version: number }
  | { kind: "not_found" }
  | { kind: "invalid_transition"; from: string; to: string }
  | { kind: "conflict" };

/**
 * 予約ステータスを1段進め、対応するタップタイムスタンプを記録する。
 * - 権限: staff（owner/admin/reception）は全件、therapist は自分の担当のみ
 *   （RLS が行スコープ、0012 のトリガが列・遷移を DB 側でも守る二重防御）
 * - 楽観ロック: version 一致 + 元 status 一致で update。0 行 = 競合（conflict）
 * - タイムスタンプは coalesce で set-once（在れば書き換えない）。
 *   in_service では arrived_at（到着）未記録なら同時に補完する
 */
export async function advanceReservationStatusCore(
  sql: Sql,
  session: Session,
  reservationId: string,
  toStatus: AdvanceTarget,
): Promise<AdvanceOutcome> {
  return withUser<AdvanceOutcome>(sql, session, async (tx) => {
    const rows = await tx<
      { id: string; status: string; version: number; therapist_id: string }[]
    >`
      select id, status::text, version, therapist_id
      from reservations
      where id = ${reservationId}::uuid
      limit 1
    `;
    const current = rows[0];
    if (!current) return { kind: "not_found" };

    // therapist は自分の担当のみ（RLS でも絞られるが、アプリ層でも明示する二重防御）
    if (
      session.role === "therapist" &&
      current.therapist_id !== session.therapistId
    ) {
      return { kind: "not_found" };
    }

    if (!canTransition(current.status, toStatus)) {
      return { kind: "invalid_transition", from: current.status, to: toStatus };
    }

    const updated = await tx<{ id: string; version: number }[]>`
      update reservations set
        status  = ${toStatus}::reservation_status,
        version = version + 1,
        enroute_at         = case when ${toStatus} = 'enroute'
                             then coalesce(enroute_at, now()) else enroute_at end,
        arrived_at         = case when ${toStatus} = 'in_service'
                             then coalesce(arrived_at, now()) else arrived_at end,
        service_started_at = case when ${toStatus} = 'in_service'
                             then coalesce(service_started_at, now()) else service_started_at end,
        done_at            = case when ${toStatus} = 'done'
                             then coalesce(done_at, now()) else done_at end
      where id = ${reservationId}::uuid
        and version = ${current.version}
        and status = ${current.status}::reservation_status
      returning id, version
    `;
    const row = updated[0];
    if (!row) return { kind: "conflict" };

    // 監査: ステータスの前進は運行記録（配車ボードの操作履歴として追える）
    await tx`
      insert into audit_logs (actor_user_id, action, entity, entity_id, before, after)
      values (
        ${session.userId}::uuid,
        'update',
        'reservation',
        ${reservationId}::uuid,
        ${tx.json({ status: current.status, version: current.version })},
        ${tx.json({ status: toStatus, version: row.version })}
      )
    `;

    return { kind: "ok", reservationId: row.id, version: row.version };
  });
}

// ---------------------------------------------------------------------------
// 2. セラピスト本人の当日タイムライン（spec 7-4。電話番号を含まない）
// ---------------------------------------------------------------------------

export interface TherapistTimelineItem {
  reservationId: string;
  status: string;
  version: number;
  /** 占有: 移動（depart→start）→ 施術（start→end）→ 移動（end→free） */
  departAtISO: string;
  startAtISO: string;
  endAtISO: string;
  freeAtISO: string;
  travelInMin: number;
  travelOutMin: number;
  courseName: string;
  courseDurationMin: number;
  areaName: string | null;
  hotelName: string | null;
  /** 180分ゲート外は null（customers_therapist_view が行を返さない） */
  customerName: string | null;
  customerNote: string | null;
  /** 180分ゲート外は null（RLS が行を返さない） */
  addressDetail: string | null;
  addressLabel: string | null;
  /** 住所が閲覧可能になる時刻（start_at - 180分）。UI のカウントダウン表示用 */
  addressVisibleFromISO: string;
  enrouteAtISO: string | null;
  arrivedAtISO: string | null;
  serviceStartedAtISO: string | null;
  doneAtISO: string | null;
  /** 移動中のまま開始時刻超過（spec 7-1） */
  delayed: boolean;
  /** 退出予定超過・退出記録なし（spec 7-3） */
  exitOverdue: boolean;
}

export type TimelineOutcome =
  | { kind: "ok"; items: TherapistTimelineItem[] }
  | { kind: "forbidden" };

interface TimelineRow {
  id: string;
  status: string;
  version: number;
  depart_at: Date;
  start_at: Date;
  end_at: Date;
  free_at: Date;
  travel_in_min: number;
  travel_out_min: number;
  course_name: string;
  course_duration_min: number;
  area_name: string | null;
  hotel_name: string | null;
  customer_name: string | null;
  customer_note: string | null;
  address_id: string | null;
  address_detail: string | null;
  address_label: string | null;
  enroute_at: Date | null;
  arrived_at: Date | null;
  service_started_at: Date | null;
  done_at: Date | null;
}

/**
 * ログイン中セラピスト自身の1日分の予定（移動→施術→移動）。
 * - **customers.phone は select しない**（spec 7-3 の列制御。顧客名は
 *   phone 列を持たない customers_therapist_view 経由）
 * - 住所は RLS の 180分ゲート内のもののみ値が入る（外は null）
 * - 住所を返した予約は audit_logs へ閲覧記録を残す（spec 13-3）
 * - status は confirmed/enroute/in_service/done（held/cancelled/noshow は
 *   RLS 上も見せない = マイページ「今日の予定」に出さない）
 */
export async function getTherapistTimelineCore(
  sql: Sql,
  session: Session,
  dateISO: string,
): Promise<TimelineOutcome> {
  if (session.role !== "therapist" || !session.therapistId) {
    // 管理側は getDispatchBoardCore を使う（経路を分けて電話番号の扱いを混ぜない）
    return { kind: "forbidden" };
  }
  const { dayStart, dayEnd } = dayBounds(dateISO);
  const now = new Date();

  const items = await withUser(sql, session, async (tx) => {
    const rows = await tx<TimelineRow[]>`
      select
        r.id, r.status::text, r.version,
        r.depart_at, r.start_at, r.end_at, r.free_at,
        r.travel_in_min, r.travel_out_min,
        co.name          as course_name,
        co.duration_min  as course_duration_min,
        ar.name          as area_name,
        h.name           as hotel_name,
        cv.name          as customer_name,
        cv.note          as customer_note,
        a.id             as address_id,
        a.detail         as address_detail,
        a.label          as address_label,
        r.enroute_at, r.arrived_at, r.service_started_at, r.done_at
      from reservations r
      join courses co on co.id = r.course_id
      left join areas ar on ar.id = r.area_id
      left join hotels h on h.id = r.hotel_id
      left join customers_therapist_view cv on cv.id = r.customer_id
      left join addresses a on a.id = r.address_id
      where r.start_at >= ${dayStart} and r.start_at < ${dayEnd}
      order by r.start_at asc
    `;

    // 住所の閲覧監査（spec 13-3「閲覧は監査ログに残す」。select では書けないため
    // 返却と同一トランザクションでここに追記する / 0001 の想定形）
    for (const row of rows) {
      if (row.address_id !== null && row.address_detail !== null) {
        await tx`
          insert into audit_logs (actor_user_id, action, entity, entity_id, after)
          values (
            ${session.userId}::uuid,
            'view',
            'address',
            ${row.address_id}::uuid,
            ${tx.json({ reservation_id: row.id, via: "therapist_timeline" })}
          )
        `;
      }
    }
    return rows;
  });

  return {
    kind: "ok",
    items: items.map((r) => ({
      reservationId: r.id,
      status: r.status,
      version: r.version,
      departAtISO: r.depart_at.toISOString(),
      startAtISO: r.start_at.toISOString(),
      endAtISO: r.end_at.toISOString(),
      freeAtISO: r.free_at.toISOString(),
      travelInMin: r.travel_in_min,
      travelOutMin: r.travel_out_min,
      courseName: r.course_name,
      courseDurationMin: r.course_duration_min,
      areaName: r.area_name,
      hotelName: r.hotel_name,
      customerName: r.customer_name,
      customerNote: r.customer_note,
      addressDetail: r.address_detail,
      addressLabel: r.address_label,
      addressVisibleFromISO: new Date(
        r.start_at.getTime() - ADDRESS_VISIBLE_BEFORE_MIN * 60_000,
      ).toISOString(),
      enrouteAtISO: r.enroute_at?.toISOString() ?? null,
      arrivedAtISO: r.arrived_at?.toISOString() ?? null,
      serviceStartedAtISO: r.service_started_at?.toISOString() ?? null,
      doneAtISO: r.done_at?.toISOString() ?? null,
      delayed: isDelayed({ status: r.status, startAt: r.start_at, now }),
      exitOverdue: isExitOverdue({ status: r.status, endAt: r.end_at, now }),
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. 配車ボード（spec 7-1。owner/admin/reception 向け）
// ---------------------------------------------------------------------------

export interface DispatchBoardItem {
  reservationId: string;
  status: string;
  version: number;
  therapistId: string;
  therapistName: string;
  departAtISO: string;
  startAtISO: string;
  endAtISO: string;
  freeAtISO: string;
  travelInMin: number;
  travelOutMin: number;
  courseName: string;
  courseDurationMin: number;
  areaName: string | null;
  hotelName: string | null;
  /** 部屋番号・住所ラベル（addresses.label。ホテルでは「部屋○○」等が入る） */
  addressLabel: string | null;
  /** 部屋番号専用列（reservations.room_number / 0025）。addressLabel より優先表示 */
  roomNumber: string | null;
  customerName: string | null;
  /** タップ発信用（spec 7-1 L692）。staff 経路のみ。therapist には決して返さない */
  customerPhone: string | null;
  /** 初回訪問の識別（spec 7-3「配車ボードで初回訪問が一目で分かること」） */
  firstVisit: boolean;
  enrouteAtISO: string | null;
  arrivedAtISO: string | null;
  serviceStartedAtISO: string | null;
  doneAtISO: string | null;
  delayed: boolean;
  exitOverdue: boolean;
  /** 送りドライバー/車（配車メモ欄 / 0024）。staff がインライン編集する */
  dispatchDriver: string | null;
  /** 配車メモ（配車メモ欄 / 0024）。staff がインライン編集する */
  dispatchMemo: string | null;
}

export type BoardOutcome =
  | { kind: "ok"; items: DispatchBoardItem[] }
  | { kind: "forbidden" };

interface BoardRow extends Omit<TimelineRow, "customer_name" | "customer_note"> {
  therapist_id: string;
  therapist_name: string | null;
  therapist_slug: string;
  customer_name: string | null;
  customer_phone: string | null;
  first_visit: boolean;
  address_label: string | null;
  room_number: string | null;
  dispatch_driver: string | null;
  dispatch_memo: string | null;
}

/**
 * 当日の全セラピストの予約（移動→施術→移動の3ブロック描画用の時刻内訳つき）。
 * 電話番号はタップ発信用に staff にのみ返す（RLS 上も therapist は customers を
 * select できない）。
 */
export async function getDispatchBoardCore(
  sql: Sql,
  session: Session,
  dateISO: string,
): Promise<BoardOutcome> {
  if (!can(toActor(session), "manage_reservations")) {
    return { kind: "forbidden" };
  }
  const { dayStart, dayEnd } = dayBounds(dateISO);
  const now = new Date();

  const rows = await withUser(sql, session, async (tx) => {
    return tx<BoardRow[]>`
      select
        r.id, r.status::text, r.version, r.therapist_id,
        er.published->>'name' as therapist_name,
        t.slug                as therapist_slug,
        r.depart_at, r.start_at, r.end_at, r.free_at,
        r.travel_in_min, r.travel_out_min,
        co.name          as course_name,
        co.duration_min  as course_duration_min,
        ar.name          as area_name,
        h.name           as hotel_name,
        a.label          as address_label,
        r.room_number,
        c.name           as customer_name,
        c.phone          as customer_phone,
        (r.customer_id is not null and not exists (
          select 1 from reservations p
          where p.customer_id = r.customer_id
            and p.id <> r.id
            and p.start_at < r.start_at
            and p.status in ('confirmed', 'enroute', 'in_service', 'done')
        )) as first_visit,
        r.enroute_at, r.arrived_at, r.service_started_at, r.done_at,
        r.dispatch_driver, r.dispatch_memo
      from reservations r
      join therapists t on t.id = r.therapist_id
      left join entity_records er
             on er.entity = 'therapist' and er.slug = t.slug
      join courses co on co.id = r.course_id
      left join areas ar on ar.id = r.area_id
      left join hotels h on h.id = r.hotel_id
      left join addresses a on a.id = r.address_id
      left join customers c on c.id = r.customer_id
      where r.start_at >= ${dayStart} and r.start_at < ${dayEnd}
        and r.status in ('confirmed', 'enroute', 'in_service', 'done')
      order by r.start_at asc, t.display_order asc
    `;
  });

  return {
    kind: "ok",
    items: rows.map((r) => ({
      reservationId: r.id,
      status: r.status,
      version: r.version,
      therapistId: r.therapist_id,
      therapistName: r.therapist_name ?? r.therapist_slug,
      departAtISO: r.depart_at.toISOString(),
      startAtISO: r.start_at.toISOString(),
      endAtISO: r.end_at.toISOString(),
      freeAtISO: r.free_at.toISOString(),
      travelInMin: r.travel_in_min,
      travelOutMin: r.travel_out_min,
      courseName: r.course_name,
      courseDurationMin: r.course_duration_min,
      areaName: r.area_name,
      hotelName: r.hotel_name,
      addressLabel: r.address_label,
      roomNumber: r.room_number,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      firstVisit: r.first_visit,
      enrouteAtISO: r.enroute_at?.toISOString() ?? null,
      arrivedAtISO: r.arrived_at?.toISOString() ?? null,
      serviceStartedAtISO: r.service_started_at?.toISOString() ?? null,
      doneAtISO: r.done_at?.toISOString() ?? null,
      delayed: isDelayed({ status: r.status, startAt: r.start_at, now }),
      exitOverdue: isExitOverdue({ status: r.status, endAt: r.end_at, now }),
      dispatchDriver: r.dispatch_driver,
      dispatchMemo: r.dispatch_memo,
    })),
  };
}

// 参考エクスポート: RLS の 180分ゲートと同じ判定を UI/他モジュールが使う場合は
// domain の canViewCustomerAddress（両方 180分で整合 / capabilities.ts）を用いる
export { canViewCustomerAddress };

// ---------------------------------------------------------------------------
// 4. dispatch_driver / dispatch_memo のインライン編集（0024 / spec 7-1 配車ボード）
// ---------------------------------------------------------------------------

export const dispatchFieldsSchema = z.object({
  reservationId: z.string().uuid(),
  driver: z.string().max(200).optional(),
  memo: z.string().max(1000).optional(),
});

export type DispatchFieldsInput = z.infer<typeof dispatchFieldsSchema>;

export type DispatchFieldsOutcome =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "forbidden" };

/**
 * 配車ボードのドライバー・メモをインライン更新する。
 * - 権限: manage_reservations（owner/admin/reception）のみ
 * - driver/memo ともに省略した呼び出しは no-op（null への明示クリアは
 *   driver: "" / memo: "" で空文字列として保存する）
 */
export async function updateDispatchFieldsCore(
  sql: Sql,
  session: Session,
  input: DispatchFieldsInput,
): Promise<DispatchFieldsOutcome> {
  if (!can(toActor(session), "manage_reservations")) {
    return { kind: "forbidden" };
  }
  if (input.driver === undefined && input.memo === undefined) {
    // 変更なし（どちらも省略は no-op）
    return { kind: "ok" };
  }

  const updated = await withUser(sql, session, async (tx) => {
    return tx<{ id: string }[]>`
      update reservations
      set
        dispatch_driver = ${input.driver !== undefined ? input.driver : sql`dispatch_driver`},
        dispatch_memo   = ${input.memo   !== undefined ? input.memo   : sql`dispatch_memo`},
        updated_at      = now()
      where id = ${input.reservationId}::uuid
      returning id
    `;
  });

  if (updated.length === 0) return { kind: "not_found" };
  return { kind: "ok" };
}
