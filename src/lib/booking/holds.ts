import "server-only";
import postgres from "postgres";
import { getClient } from "@/lib/db-client";
import { getTherapistSlots } from "@/lib/availability/public-slots";
import type { AvailableSlot } from "@/domain/availability";
import { DEFAULT_BOOKING_FEES, feeBreakdown } from "@/domain/booking";
import type { BookingFeeSettings, FeeBreakdown } from "@/domain/booking";
import { insertFunnelEvent, isValidFunnelSession } from "./funnel";

/**
 * 仮押さえ・確定（フェーズ11 / spec 5-5・6章 ★同時実行の安全性が核）。
 *
 * 方式（spec 5-5「reservations に status='held' で入れて exclusion 制約で守るのが確実」）:
 * 1. createHold が engine の再計算で得た枠（depart_at〜free_at の内訳つき）を
 *    **reservations に status='held' で insert** する。同じ枠への同時リクエストは
 *    DB の exclusion 制約 no_therapist_overlap が裁定し、片方だけが成功する。
 *    アプリ側の事前チェックは行わない（チェックしても同時リクエストで抜ける / spec 4章）。
 * 2. slot_holds に session_id / expires_at（10分）を控える。期限切れは
 *    release_expired_holds() が held 行ごと削除して枠を解放する（参照時の除外は
 *    loadActiveReservations 側でも行う二重防御）。
 * 3. confirmReservation が held → confirmed に遷移させる。**version 楽観ロック**
 *    （update ... where id = $1 and version = $2）で古い version の保存を拒否する。
 *
 * エラーは列挙コードで返し、**生の Postgres エラーを画面に出さない**（spec 4章）。
 * 表示文言（「他のお客様の予約が先に確定しました」等）は CMS の ui_labels が持ち、
 * 公開側コンポーネントがコードから引く（直書き日本語0）。
 */

/** ホールドの有効時間（分 / spec 5-5「10分間のホールド」） */
export const HOLD_MINUTES = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HoldError = "invalid" | "slot_gone" | "slot_taken";

export interface HoldSuccess {
  ok: true;
  reservationId: string;
  /** 楽観ロックの初期 version（0）。確定時にそのまま返す */
  version: number;
  expiresAtISO: string;
  startAtISO: string;
  serviceEndAtISO: string;
  holdMinutes: number;
  /** 料金内訳（spec 6章「料金は最後まで隠さない」の常時表示に使う） */
  fees: FeeBreakdown;
  areaId: string;
  areaName: string;
}

export type HoldResult = HoldSuccess | { ok: false; error: HoldError };

export type ConfirmError =
  | "invalid"
  | "hold_not_found"
  | "hold_expired"
  | "version_conflict";

export interface ConfirmSuccess {
  ok: true;
  reservationId: string;
  version: number;
  totalAmount: number;
}

export type ConfirmResult = ConfirmSuccess | { ok: false; error: ConfirmError };

/** exclusion 制約違反（同時取得の敗者）か（spec 4章の日本語変換の判定点） */
export function isSlotTakenError(e: unknown): boolean {
  return (
    e instanceof postgres.PostgresError &&
    e.code === "23P01" &&
    e.constraint_name === "no_therapist_overlap"
  );
}

/**
 * reservations の CHECK 制約違反（23514）か。占有区間の順序
 * （reservations_occupy_order_check: depart_at ≤ start_at かつ free_at ≥ end_at）等を
 * 破る insert/update が該当する。override 経路の手動 insert が誤った区間を組んだ
 * 場合に発生しうるため、exclusion（23P01）と同様に生の Postgres エラーを画面に
 * 出さず日本語へ変換するための判定点（spec 4章）。
 */
export function isOccupancyCheckError(e: unknown): boolean {
  return (
    e instanceof postgres.PostgresError &&
    e.code === "23514" &&
    (e.constraint_name ?? "").startsWith("reservations_")
  );
}

/**
 * 再試行可能なトランザクション競合か。GiST の exclusion 制約は**完全に同時**の
 * insert 同士が互いの投機的エントリを待ち合い、deadlock（40P01）として片方が
 * 中断されることがある（勝敗の裁定自体は正しい）。中断された側は再計算からやり
 * 直せば、勝者の行が見えて slot_gone / slot_taken に正しく収束する。
 */
function isRetryableTxError(e: unknown): boolean {
  return (
    e instanceof postgres.PostgresError && (e.code === "40P01" || e.code === "40001")
  );
}

/** 期限切れホールドの解放（spec 5-5。cron 配線はフェーズ20 / 各アクションの冒頭でも呼ぶ） */
export async function releaseExpiredHolds(): Promise<number> {
  const sql = getClient();
  const rows = await sql<{ release_expired_holds: number }[]>`
    select release_expired_holds()
  `;
  return rows[0]?.release_expired_holds ?? 0;
}

interface CourseRow {
  id: string;
  price: number;
  duration_min: number;
  nomination_fee_default: number;
}

export interface OptionSnapshotRow {
  id: string;
  price: number;
  duration_min: number;
  back_type: "fixed" | "rate";
  back_value: number;
}

/** site_settings.booking_fees の読み取り（壊れていれば spec 18-3 の既定値） */
export async function loadBookingFees(): Promise<BookingFeeSettings> {
  const sql = getClient();
  const rows = await sql<{ value: unknown }[]>`
    select value from site_settings where key = 'booking_fees' limit 1
  `;
  const raw = rows[0]?.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_BOOKING_FEES;
  const rec = raw as Record<string, unknown>;
  const int = (key: string, fallback: number): number => {
    const v = rec[key];
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
  };
  return {
    transportWalk: int("transport_walk", DEFAULT_BOOKING_FEES.transportWalk),
    transportCar: int("transport_car", DEFAULT_BOOKING_FEES.transportCar),
    midnightSurcharge: int("midnight_surcharge", DEFAULT_BOOKING_FEES.midnightSurcharge),
    midnightFromHour: int("midnight_from_hour", DEFAULT_BOOKING_FEES.midnightFromHour),
    midnightToHour: int("midnight_to_hour", DEFAULT_BOOKING_FEES.midnightToHour),
  };
}

/**
 * 仮押さえ（spec 5-5 / 6章 手順4）。
 *
 * engine を**サーバ側で再計算**して、要求された開始時刻の枠が今も成立するかを
 * 確かめてから held を insert する（クライアントが送る時刻を信用しない）。
 * 併走で同じ枠を取られた場合は exclusion 制約が insert を拒否し、
 * error='slot_taken' を返す。
 */
export async function createHold(params: HoldParams): Promise<HoldResult> {
  if (!isValidFunnelSession(params.sessionId)) return { ok: false, error: "invalid" };
  if (!UUID_RE.test(params.courseId)) return { ok: false, error: "invalid" };
  if (Number.isNaN(Date.parse(params.startAtISO))) return { ok: false, error: "invalid" };
  const now = params.now ?? new Date();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await attemptCreateHold(params, now);
    } catch (e) {
      // 同時取得の敗者: 生の Postgres エラーを外に出さず列挙コードへ変換（spec 4章）
      if (isSlotTakenError(e)) return { ok: false, error: "slot_taken" };
      if (isRetryableTxError(e)) {
        // 完全同時の deadlock 裁定で中断された側: 1回だけ再計算からやり直す。
        // 勝者の held が見えれば slot_gone、まだ競っていれば exclusion が裁く
        if (attempt === 0) continue;
        return { ok: false, error: "slot_taken" };
      }
      throw e;
    }
  }
  return { ok: false, error: "slot_taken" };
}

interface HoldParams {
  slug: string;
  dateISO: string;
  startAtISO: string;
  areaId?: string | null;
  courseId: string;
  optionIds?: readonly string[];
  hotelId?: string | null;
  sessionId: string;
  now?: Date;
}

async function attemptCreateHold(params: HoldParams, now: Date): Promise<HoldResult> {
  const startAtMs = Date.parse(params.startAtISO);
  const sql = getClient();

  // 期限切れホールドを先に解放する（exclusion は期限切れ held も占有と数えるため、
  // 解放しないと空いたはずの枠が取れない）
  await releaseExpiredHolds();

  // サーバ側の再計算で枠を再解決（spec 5-3。既存予約・ホールド込み）
  const result = await getTherapistSlots({
    slug: params.slug,
    dateISO: params.dateISO,
    areaId: params.areaId ?? null,
    courseId: params.courseId,
    optionIds: params.optionIds ?? [],
    hotelId: params.hotelId ?? null,
    now,
  });
  if (!result || result.therapistId === "") return { ok: false, error: "slot_gone" };
  const slot: AvailableSlot | undefined = result.rawSlots.find(
    (s) => s.startAt.getTime() === startAtMs,
  );
  if (!slot) return { ok: false, error: "slot_gone" };

  // 料金の材料（コース・オプション・料金設定）。オプションは engine と同じ絞り込み
  const [courseRows, optionRows, fees] = await Promise.all([
    sql<CourseRow[]>`
      select id, price, duration_min, nomination_fee_default
      from courses where id = ${params.courseId}::uuid and is_active = true
      limit 1
    `,
    loadOptionSnapshots(sql, {
      optionIds: params.optionIds ?? [],
      therapistId: result.therapistId,
    }),
    loadBookingFees(),
  ]);
  const course = courseRows[0];
  if (!course) return { ok: false, error: "invalid" };

  // エリア別交通費（車のとき使う。徒歩圏は 0 / spec 3-8・発注者決定 2026-09-04）
  const areaFeeRows = result.areaId
    ? await sql<{ transport_fee: number }[]>`
        select transport_fee from areas where id = ${result.areaId}::uuid limit 1
      `
    : [];
  const areaTransportFee = areaFeeRows[0]?.transport_fee ?? null;

  // 指名料: 公開フローで特定セラピストを選ぶ = 指名（通常指名の既定額 / spec 18-3。
  // 個人別特別指名・therapist_courses の上書きはフェーズ16/18 で精緻化）
  const breakdown = feeBreakdown({
    coursePrice: course.price,
    optionPrices: optionRows.map((o) => o.price),
    nominationFee: course.nomination_fee_default,
    travelInMode: slot.travelInMode,
    startAt: slot.startAt,
    settings: fees,
    areaTransportFee,
  });

  const expiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);

  const holdRow = await sql.begin(async (tx) => {
      const inserted = await tx<{ id: string; version: number }[]>`
        insert into reservations (
          therapist_id, area_id, course_id, hotel_id,
          start_at, end_at, depart_at, free_at,
          travel_in_min, travel_out_min, buffer_min,
          status, nomination_fee, transport_fee, total_amount
        ) values (
          ${result.therapistId}::uuid, ${result.areaId}::uuid, ${course.id}::uuid,
          ${params.hotelId ?? null}::uuid,
          ${slot.startAt}, ${slot.serviceEndAt}, ${slot.departAt}, ${slot.freeAt},
          ${slot.travelInMin}, ${slot.travelOutMin}, ${slot.bufferTotalMin},
          'held', ${breakdown.nominationFee}, ${breakdown.transportFee},
          ${breakdown.totalAmount}
        )
        returning id, version
      `;
      const reservation = inserted[0];
      if (!reservation) throw new Error("held insert returned no row");

      await tx`
        insert into slot_holds (
          reservation_id, therapist_id, start_at, end_at, depart_at, free_at,
          session_id, expires_at
        ) values (
          ${reservation.id}::uuid, ${result.therapistId}::uuid,
          ${slot.startAt}, ${slot.serviceEndAt}, ${slot.departAt}, ${slot.freeAt},
          ${params.sessionId}, ${expiresAt}
        )
      `;

      // オプションのスナップショット（spec 3-4: 後から値を変えても過去の予約は不変）
      for (const opt of optionRows) {
        await tx`
          insert into reservation_options (
            reservation_id, option_id, price_snapshot, duration_snapshot,
            back_type_snapshot, back_value_snapshot
          ) values (
            ${reservation.id}::uuid, ${opt.id}::uuid, ${opt.price}, ${opt.duration_min},
            ${opt.back_type}::option_back_type, ${opt.back_value}
          )
        `;
      }

      await insertFunnelEvent(tx, {
        sessionId: params.sessionId,
        step: "hold",
        therapistId: result.therapistId,
        meta: { reservationId: reservation.id, startAt: params.startAtISO },
      });

      return reservation;
  });

  return {
    ok: true,
    reservationId: holdRow.id,
    version: holdRow.version,
    expiresAtISO: expiresAt.toISOString(),
    startAtISO: slot.startAt.toISOString(),
    serviceEndAtISO: slot.serviceEndAt.toISOString(),
    holdMinutes: HOLD_MINUTES,
    fees: breakdown,
    areaId: result.areaId,
    areaName: result.areaName,
  };
}

/**
 * 自分のホールドを明示的に解放する（「別の時間を選び直す」導線）。
 * session_id が一致する held 行だけを削除する（他人のホールドは消せない）。
 */
export async function releaseHold(params: {
  reservationId: string;
  sessionId: string;
}): Promise<boolean> {
  if (!UUID_RE.test(params.reservationId) || !isValidFunnelSession(params.sessionId)) {
    return false;
  }
  const sql = getClient();
  const rows = await sql<{ id: string }[]>`
    delete from reservations r
    using slot_holds h
    where h.reservation_id = r.id
      and r.id = ${params.reservationId}::uuid
      and r.status = 'held'
      and h.session_id = ${params.sessionId}
    returning r.id
  `;
  return rows.length > 0;
}

/** 確定フローを中断してロールバックするための内部例外（コード持ち） */
class ConfirmAbort extends Error {
  constructor(readonly code: ConfirmError) {
    super(`confirm aborted: ${code}`);
  }
}

/**
 * 予約の確定（spec 6章 手順5〜10 / held → confirmed）。
 *
 * - slot_holds の session_id 一致と期限内であることを確認（他人のホールドは確定不可）
 * - 顧客は電話番号で名寄せ（upsert / spec 9章）
 * - 住所は addresses に追加（複数登録可。エリアは held 時に確定した area_id）
 * - **楽観ロック**: `where version = $expectedVersion` の 0 行更新は version_conflict
 */
export async function confirmReservation(params: {
  reservationId: string;
  sessionId: string;
  /** createHold が返した version（楽観ロックの期待値） */
  version: number;
  customerName: string;
  customerPhone: string;
  addressDetail: string;
  addressLabel?: string | null;
  now?: Date;
}): Promise<ConfirmResult> {
  if (
    !UUID_RE.test(params.reservationId) ||
    !isValidFunnelSession(params.sessionId) ||
    !Number.isInteger(params.version) ||
    params.version < 0 ||
    params.customerName.trim() === "" ||
    !/^0[0-9]{9,10}$/.test(params.customerPhone) ||
    params.addressDetail.trim() === ""
  ) {
    return { ok: false, error: "invalid" };
  }
  const now = params.now ?? new Date();
  const sql = getClient();

  await releaseExpiredHolds();

  try {
    const confirmed = await sql.begin(async (tx) => {
      // 行ロックで同一ホールドへの並走確定を直列化
      const rows = await tx<
        {
          id: string;
          status: string;
          version: number;
          therapist_id: string;
          area_id: string;
          hotel_id: string | null;
          total_amount: number;
          session_id: string;
          expires_at: Date;
        }[]
      >`
        select r.id, r.status, r.version, r.therapist_id, r.area_id, r.hotel_id,
               r.total_amount, h.session_id, h.expires_at
        from reservations r
        join slot_holds h on h.reservation_id = r.id
        where r.id = ${params.reservationId}::uuid
        for update of r
      `;
      const hold = rows[0];
      if (!hold || hold.status !== "held" || hold.session_id !== params.sessionId) {
        throw new ConfirmAbort("hold_not_found");
      }
      if (hold.expires_at.getTime() <= now.getTime()) {
        throw new ConfirmAbort("hold_expired");
      }

      // 顧客: 電話番号で名寄せ（spec 9章）。
      // 既存顧客の氏名は**上書きしない**（未検証のWeb入力が、電話受付の自動補完(フェーズ12)が
      // 頼る既存氏名を壊さないため / reviewer 推奨2）。既存が空のときだけ補完する。
      const customers = await tx<{ id: string }[]>`
        insert into customers (phone, name)
        values (${params.customerPhone}, ${params.customerName.trim()})
        on conflict (phone) do update
          set name = coalesce(nullif(customers.name, ''), excluded.name),
              updated_at = now()
        returning id
      `;
      const customerId = customers[0]?.id;
      if (!customerId) throw new Error("customer upsert returned no row");

      // 住所（複数登録可 / spec 9章。座標はジオコーディング配線後に補完）
      const addresses = await tx<{ id: string }[]>`
        insert into addresses (customer_id, kind, hotel_id, label, detail, area_id)
        values (
          ${customerId}::uuid,
          ${hold.hotel_id ? "hotel" : "home"}::address_kind,
          ${hold.hotel_id}::uuid,
          ${params.addressLabel?.trim() || null},
          ${params.addressDetail.trim()},
          ${hold.area_id}::uuid
        )
        returning id
      `;
      const addressId = addresses[0]?.id;
      if (!addressId) throw new Error("address insert returned no row");

      // ★楽観ロック: 期待 version と一致した場合だけ確定できる（spec 4章・15章）
      const updated = await tx<{ version: number }[]>`
        update reservations
        set status = 'confirmed',
            customer_id = ${customerId}::uuid,
            address_id = ${addressId}::uuid,
            version = version + 1
        where id = ${params.reservationId}::uuid
          and version = ${params.version}
          and status = 'held'
        returning version
      `;
      const row = updated[0];
      if (!row) throw new ConfirmAbort("version_conflict");

      // 確定したのでホールドの追跡行は不要（期限切れ削除の対象からも外れる）
      await tx`
        delete from slot_holds where reservation_id = ${params.reservationId}::uuid
      `;

      await insertFunnelEvent(tx, {
        sessionId: params.sessionId,
        step: "confirm",
        therapistId: hold.therapist_id,
        meta: { reservationId: hold.id },
      });

      return { version: row.version, totalAmount: hold.total_amount };
    });

    return {
      ok: true,
      reservationId: params.reservationId,
      version: confirmed.version,
      totalAmount: confirmed.totalAmount,
    };
  } catch (e) {
    if (e instanceof ConfirmAbort) return { ok: false, error: e.code };
    throw e;
  }
}

/**
 * 選択オプションのスナップショット材料（engine の L 計算と同じ絞り込み:
 * is_active・is_public・option_availability の対応 / spec 3-4）。
 * 電話受付の override 経路（フェーズ12）も同じ絞り込みで L と金額を組むため export。
 */
export async function loadOptionSnapshots(
  sql: ReturnType<typeof getClient>,
  params: { optionIds: readonly string[]; therapistId: string },
): Promise<OptionSnapshotRow[]> {
  const valid = params.optionIds.filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return [];
  return sql<OptionSnapshotRow[]>`
    select o.id, o.price, o.duration_min, o.back_type, o.back_value
    from options o
    where o.id = any(${valid}::uuid[])
      and o.is_active = true
      and o.is_public = true
      and (
        not exists (select 1 from option_availability oa where oa.option_id = o.id)
        or exists (
          select 1 from option_availability oa
          where oa.option_id = o.id and oa.therapist_id = ${params.therapistId}::uuid
        )
      )
  `;
}
