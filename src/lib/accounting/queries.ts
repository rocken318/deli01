import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { midnightSurcharge as midnightFee } from "@/domain/booking";
import type { BookingFeeSettings } from "@/domain/booking";
import {
  deferredRevenue,
  pointLiability,
  revenueBreakdown,
  settlement,
  ticketRedeemAmount,
} from "@/domain/accounting";
import type {
  PointLiabilityBreakdown,
  RevenueLineDraft,
  RevenueLineType,
  Settlement,
} from "@/domain/accounting";

/**
 * フェーズ17 会計の中核（spec 10章 L853-869・9章 L844-849・11-6）。
 * Server Action（actions.ts / 'use server'）から Session を受け取って動く
 * （points/queries.ts と同じ構成。統合テストはここへ直接 Session を渡す）。
 *
 * 台帳の規約（migrations/0015 の設計ノートと対）:
 * - revenue_lines / payments / ticket_entries は追記専用（update/delete は grant なし）。
 *   修正は逆仕訳の追記
 * - 二重計上の防止は DB の部分 unique（core_uniq / singleton_uniq / option_uniq /
 *   redeem_reservation_uniq）が最終防衛線。アプリの事前チェックはユーザー向け文言のため
 * - 集計（getAccountingSummaryCore）は revenue_lines だけを読む（spec L858）
 *
 * ポイント会計連動の結線（spec L844-849。フェーズ16 の先送り分）:
 * - **利用**: 台帳の増減は従来どおり usePoints（フェーズ16）。売上側は
 *   postReservationRevenueCore が同予約の use 行（point_entries）を読み、
 *   **マイナスの point_use 行**を1本立てる（L847）。書き手を一箇所にして二重計上を防ぎ、
 *   さらに DB の singleton_uniq(point_use) が並行実行も止める。
 *   運用順序: 精算（done）時に usePoints → postReservationRevenue
 * - **付与**: revenue_line を立てない（売上を減らさない / L846）。引当は
 *   point_entries の残として getAccountingSummaryCore が別枠で返す
 * - **失効**: expirePoints の expire 行が引当残を減らす = 戻入（L849）。売上には現れない
 * - **バック基礎への算入**（L848 既定「含める」）: site_settings.payout_policy
 *   （policy.ts）。フェーズ18 が読む
 *
 * 回数券（spec L857・L917）:
 * - 発行（purchase）= 前受金。売上には計上しない
 * - 消化（redeem）= 前受金から売上への振替。redeem 行（−配分額）と
 *   revenue_lines の ticket_redeem 行（＋配分額）を同一トランザクションで追記。
 *   振替額は端数配分（受入 L1092: 10,000円3回券 → 3,333/3,333/3,334）
 * - 消化予約には course 行を立てない（振替との二重計上 = 売上の水増しになる。
 *   DB の core_uniq が course/ticket_redeem の同居を物理的に拒否）。
 *   このため **redeem は postReservationRevenue より先に行う**
 * - バックは施術に対して発生する（L917）。フェーズ18 が reservations 起点で計算する
 *   ため、ここの振替額とは独立（前受金の振替と報酬を混同しない）
 */

// ---------------------------------------------------------------------------
// 共通型
// ---------------------------------------------------------------------------

export type PaymentMethod = "cash" | "card" | "emoney" | "ticket" | "point";
export type ExpenseCategory = "oil" | "supplies" | "parking" | "ads" | "other";

export interface CustomerRef {
  customerId?: string;
  phone?: string;
}

async function resolveCustomerForUpdate(
  tx: TransactionSql,
  ref: CustomerRef,
): Promise<{ id: string } | undefined> {
  if (!ref.customerId && !ref.phone) return undefined;
  const rows = ref.customerId
    ? await tx<{ id: string }[]>`
        select id from customers where id = ${ref.customerId}::uuid for update`
    : await tx<{ id: string }[]>`
        select id from customers where phone = ${ref.phone ?? ""} for update`;
  return rows[0];
}

function pgErrorInfo(e: unknown): { code?: string; constraint?: string } {
  if (typeof e === "object" && e !== null) {
    const rec = e as { code?: unknown; constraint_name?: unknown };
    return {
      code: typeof rec.code === "string" ? rec.code : undefined,
      constraint:
        typeof rec.constraint_name === "string" ? rec.constraint_name : undefined,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// 1. 予約の売上計上（spec L856: 独立行・合算しない）
// ---------------------------------------------------------------------------

export interface PostRevenueParams {
  reservationId: string;
  /** CMS の料金設定（深夜加算の再計算に使う）。actions.ts が loadBookingFees で渡す */
  fees: BookingFeeSettings;
  /** 支払方法の内訳（現金＋カード等の併用可 / spec L855）。省略時は記録しない */
  payments?: ReadonlyArray<{ method: PaymentMethod; amount: number }>;
  now?: Date;
}

export type PostRevenueOutcome =
  | { kind: "ok"; lines: RevenueLineDraft[]; pointsUsed: number; ticketPaid: boolean }
  | { kind: "not_found" }
  | { kind: "not_done"; status: string }
  | { kind: "already_posted" }
  | { kind: "inconsistent"; detail: string };

/**
 * 施術完了（done）した予約の売上を revenue_lines に計上する。
 *
 * - course/option/nomination/transport/midnight を独立行で（合算しない / spec L856）
 * - course 行の額は残差で決める:
 *     course = total_amount − Σoption(snapshot) − nomination_fee − transport_fee − 深夜加算
 *   （reservations にコース価格のスナップショット列が無いため。合計 = total_amount の
 *   不変条件を最優先し、courses.price の後変更の影響を受けない）
 * - ポイント利用（同予約の point_entries.use）はマイナスの point_use 行（spec L847）
 * - 回数券消化済み（ticket_redeem 行あり）の予約は course 行を立てない（振替に置換済み）
 * - 冪等: 既計上なら already_posted。並行実行は DB の部分 unique が止める
 */
export async function postReservationRevenueCore(
  sql: Sql,
  session: Session,
  params: PostRevenueParams,
): Promise<PostRevenueOutcome> {
  const now = params.now ?? new Date();
  try {
    return await withUser(sql, session, async (tx) => {
      const resRows = await tx<
        {
          id: string;
          status: string;
          start_at: Date;
          area_id: string;
          therapist_id: string;
          nomination_fee: number;
          transport_fee: number;
          total_amount: number;
        }[]
      >`
        select id, status::text as status, start_at, area_id, therapist_id,
               nomination_fee, transport_fee, total_amount
        from reservations
        where id = ${params.reservationId}::uuid
        for update
      `;
      const r = resRows[0];
      if (!r) return { kind: "not_found" } as const;
      // 売上の認識時点は施術完了（done）。確定段階では計上しない
      if (r.status !== "done") {
        return { kind: "not_done", status: r.status } as const;
      }

      // 既計上チェック（ユーザー向け）。並行実行の最終防衛線は DB unique
      const existing = await tx<{ line_type: string }[]>`
        select line_type::text as line_type from revenue_lines
        where reservation_id = ${r.id}::uuid and reversal_of is null
      `;
      const existingTypes = new Set(existing.map((e) => e.line_type));
      const feeTypes = ["course", "option", "nomination", "transport", "midnight", "point_use"];
      if (feeTypes.some((t) => existingTypes.has(t))) {
        return { kind: "already_posted" } as const;
      }
      // redeemTicketCore が先に振替済みなら course 行は立てない（二重計上防止）
      const ticketPaid = existingTypes.has("ticket_redeem");

      const optionRows = await tx<{ option_id: string; price_snapshot: number }[]>`
        select option_id, price_snapshot from reservation_options
        where reservation_id = ${r.id}::uuid
        order by created_at, option_id
      `;
      const optionsTotal = optionRows.reduce((s, o) => s + o.price_snapshot, 0);
      const midnight = midnightFee(r.start_at, params.fees);
      const coursePrice =
        r.total_amount - optionsTotal - r.nomination_fee - r.transport_fee - midnight;
      if (coursePrice < 0) {
        return {
          kind: "inconsistent",
          detail: `course residual ${coursePrice} < 0 (total=${r.total_amount})`,
        } as const;
      }

      // ポイント利用（同予約の use 行の合計）→ マイナスの point_use 行（spec L847）
      const pointRows = await tx<{ used: number }[]>`
        select coalesce(-sum(points), 0)::integer as used
        from point_entries
        where reservation_id = ${r.id}::uuid and type = 'use'
      `;
      const pointsUsed = pointRows[0]?.used ?? 0;

      const lines = revenueBreakdown({
        coursePrice,
        options: optionRows.map((o) => ({ optionId: o.option_id, price: o.price_snapshot })),
        nominationFee: r.nomination_fee,
        transportFee: r.transport_fee,
        midnightSurcharge: midnight,
        // 振替済みの場合は course を抑止（ticket_redeem 行自体は既存なので 0 で重複させない）
        ticketRedeemAmount: ticketPaid ? 0 : null,
        pointsUsed,
      });

      for (const line of lines) {
        await tx`
          insert into revenue_lines
            (reservation_id, line_type, amount, area_id, therapist_id,
             option_id, occurred_at, created_by)
          values (
            ${r.id}::uuid,
            ${line.lineType}::revenue_line_type,
            ${line.amount},
            ${r.area_id}::uuid,
            ${r.therapist_id}::uuid,
            ${line.optionId ?? null},
            ${r.start_at},
            ${session.userId}::uuid
          )
        `;
      }

      // payments は計上行が立つ初回のみ記録する。fee 行が無い（全額回数券振替済み等）
      // 予約で post を繰り返しても payments が重複挿入されないようにする（reviewer S1。
      // 回数券の支払内訳は redeemTicketCore が method='ticket' で既に記録済み）。
      if (lines.length > 0) {
        for (const p of params.payments ?? []) {
          await tx`
            insert into payments (reservation_id, method, amount, occurred_at, created_by)
            values (
              ${r.id}::uuid, ${p.method}::payment_method, ${p.amount},
              ${now}, ${session.userId}::uuid
            )
          `;
        }
      }

      return { kind: "ok", lines, pointsUsed, ticketPaid } as const;
    });
  } catch (e) {
    // 並行の二重計上を DB unique が弾いた（reviewer B2 の教訓 = DB 制約で担保）
    if (pgErrorInfo(e).code === "23505") {
      return { kind: "already_posted" };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 2. 回数券: 発行（前受金）
// ---------------------------------------------------------------------------

export interface SellTicketParams extends CustomerRef {
  /** 回数（正の整数） */
  count: number;
  /** 券面総額（円）。前受金として全額を積む */
  totalAmount: number;
  /** 名目単価（表示用・任意。正は totalAmount） */
  unitPrice?: number | null;
  /** 失効期限。null = 無期限 */
  expiresAt?: Date | null;
  reason?: string;
  now?: Date;
}

export type SellTicketOutcome =
  | {
      kind: "ok";
      entryId: string;
      customerId: string;
      remainingCount: number;
      deferredAmount: number;
    }
  | { kind: "customer_not_found" }
  | { kind: "invalid" };

/** 回数券の発行 = 前受金の計上（spec L857）。売上（revenue_lines）には積まない */
export async function sellTicketCore(
  sql: Sql,
  session: Session,
  params: SellTicketParams,
): Promise<SellTicketOutcome> {
  if (
    !Number.isSafeInteger(params.count) ||
    params.count <= 0 ||
    !Number.isSafeInteger(params.totalAmount) ||
    params.totalAmount < 0
  ) {
    return { kind: "invalid" };
  }
  const now = params.now ?? new Date();
  return withUser(sql, session, async (tx) => {
    const customer = await resolveCustomerForUpdate(tx, params);
    if (!customer) return { kind: "customer_not_found" } as const;

    const inserted = await tx<{ id: string }[]>`
      insert into ticket_entries
        (customer_id, type, count, amount, unit_price, reason, expires_at,
         occurred_at, created_by)
      values (
        ${customer.id}::uuid, 'purchase', ${params.count}, ${params.totalAmount},
        ${params.unitPrice ?? null}, ${params.reason ?? null},
        ${params.expiresAt ?? null}, ${now}, ${session.userId}::uuid
      )
      returning id::text as id
    `;
    const entry = inserted[0];
    if (!entry) return { kind: "invalid" } as const;
    const bal = await selectTicketBalance(tx, customer.id);
    return {
      kind: "ok",
      entryId: entry.id,
      customerId: customer.id,
      remainingCount: bal.remainingCount,
      deferredAmount: bal.deferredAmount,
    } as const;
  });
}

// ---------------------------------------------------------------------------
// 3. 回数券: 消化（前受金 → 売上への振替）
// ---------------------------------------------------------------------------

interface TicketLotRow {
  id: string;
  count: number;
  amount: number;
  expires_at: Date | null;
  remaining: number;
}

/** 顧客の回数券残（残回数・前受金残高）。tx 内で使う */
async function selectTicketBalance(
  tx: TransactionSql,
  customerId: string,
): Promise<{ remainingCount: number; deferredAmount: number }> {
  const rows = await tx<{ count: number; amount: number }[]>`
    select count, amount from ticket_entries where customer_id = ${customerId}::uuid
  `;
  const d = deferredRevenue(rows);
  return { remainingCount: d.remainingCount, deferredAmount: d.deferredAmount };
}

export interface RedeemTicketParams extends CustomerRef {
  reservationId: string;
  now?: Date;
}

export type RedeemTicketOutcome =
  | {
      kind: "ok";
      lotId: string;
      redeemAmount: number;
      remainingCount: number;
      deferredAmount: number;
    }
  | { kind: "customer_not_found" }
  | { kind: "reservation_not_found" }
  | { kind: "customer_mismatch" }
  | { kind: "invalid_status"; status: string }
  | { kind: "no_ticket" }
  | { kind: "already_redeemed" }
  | { kind: "course_already_posted" }
  | { kind: "invalid" };

/**
 * 回数券の消化。FIFO で古い購入ロットから 1 回分を消化し、同一トランザクションで
 *   1. ticket_entries に redeem 行（count −1・amount −配分額）
 *   2. revenue_lines に ticket_redeem 行（＋配分額 = 前受金からの振替）
 *   3. payments に method='ticket' 行（支払方法内訳 / spec L855）
 * を追記する。振替額は端数配分（受入 L1092）。
 *
 * course 行が既に立っている予約への消化は拒否する（振替との二重計上防止。
 * DB の revenue_lines_core_uniq が最終防衛線）。逆順にしたい場合は先に
 * 売上計上を逆仕訳すること。
 */
export async function redeemTicketCore(
  sql: Sql,
  session: Session,
  params: RedeemTicketParams,
): Promise<RedeemTicketOutcome> {
  const now = params.now ?? new Date();
  try {
    return await withUser(sql, session, async (tx) => {
      const customer = await resolveCustomerForUpdate(tx, params);
      if (!customer) return { kind: "customer_not_found" } as const;

      const resRows = await tx<
        {
          id: string;
          customer_id: string | null;
          status: string;
          start_at: Date;
          area_id: string;
          therapist_id: string;
        }[]
      >`
        select id, customer_id, status::text as status, start_at, area_id, therapist_id
        from reservations
        where id = ${params.reservationId}::uuid
        for update
      `;
      const r = resRows[0];
      if (!r) return { kind: "reservation_not_found" } as const;
      if (r.customer_id !== null && r.customer_id !== customer.id) {
        return { kind: "customer_mismatch" } as const;
      }
      if (!["confirmed", "in_service", "done"].includes(r.status)) {
        return { kind: "invalid_status", status: r.status } as const;
      }

      // 同一予約への二重消化の事前判定（最終防衛線は redeem_reservation_uniq）
      const redeemed = await tx<{ n: number }[]>`
        select count(*)::int as n from ticket_entries
        where reservation_id = ${r.id}::uuid and type = 'redeem'
      `;
      if ((redeemed[0]?.n ?? 0) > 0) {
        return { kind: "already_redeemed" } as const;
      }

      // course 行が既に立っていれば拒否（core_uniq の事前判定。文言のため）
      const posted = await tx<{ n: number }[]>`
        select count(*)::int as n from revenue_lines
        where reservation_id = ${r.id}::uuid
          and line_type in ('course', 'ticket_redeem')
          and reversal_of is null
      `;
      if ((posted[0]?.n ?? 0) > 0) {
        return { kind: "course_already_posted" } as const;
      }

      // FIFO: 期限内・残ありの最古ロット（spec L837 のポイントと同じ先入先出）
      const lots = await tx<TicketLotRow[]>`
        select
          e.id::text as id,
          e.count,
          e.amount,
          e.expires_at,
          (e.count + coalesce(
            (select sum(c.count) from ticket_entries c where c.lot_id = e.id), 0
          ))::integer as remaining
        from ticket_entries e
        where e.customer_id = ${customer.id}::uuid
          and e.type = 'purchase'
        order by e.occurred_at, e.id
      `;
      const lot = lots.find(
        (l) => l.remaining > 0 && (l.expires_at === null || l.expires_at > now),
      );
      if (!lot) return { kind: "no_ticket" } as const;

      // 振替額 = このロットの (消化済み回数+1) 回目の配分（端数は後ろの回に寄る）
      const redeemAmount = ticketRedeemAmount({
        totalAmount: lot.amount,
        count: lot.count,
        redeemedSoFar: lot.count - lot.remaining,
      });

      await tx`
        insert into ticket_entries
          (customer_id, type, count, amount, reservation_id, lot_id,
           occurred_at, created_by)
        values (
          ${customer.id}::uuid, 'redeem', -1, ${-redeemAmount},
          ${r.id}::uuid, ${lot.id}::bigint, ${now}, ${session.userId}::uuid
        )
      `;

      if (redeemAmount > 0) {
        // 前受金 → 売上への振替（現金売上と混同しない / spec L857・L917）
        await tx`
          insert into revenue_lines
            (reservation_id, line_type, amount, area_id, therapist_id,
             occurred_at, created_by)
          values (
            ${r.id}::uuid, 'ticket_redeem', ${redeemAmount},
            ${r.area_id}::uuid, ${r.therapist_id}::uuid,
            ${r.start_at}, ${session.userId}::uuid
          )
        `;
        await tx`
          insert into payments (reservation_id, method, amount, occurred_at, created_by)
          values (${r.id}::uuid, 'ticket', ${redeemAmount}, ${now}, ${session.userId}::uuid)
        `;
      }

      const bal = await selectTicketBalance(tx, customer.id);
      return {
        kind: "ok",
        lotId: lot.id,
        redeemAmount,
        remainingCount: bal.remainingCount,
        deferredAmount: bal.deferredAmount,
      } as const;
    });
  } catch (e) {
    const info = pgErrorInfo(e);
    if (info.code === "23505") {
      // どの unique に当たったかで文言を分ける
      if (info.constraint === "revenue_lines_core_uniq") {
        return { kind: "course_already_posted" };
      }
      return { kind: "already_redeemed" };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 4. 回数券: 逆仕訳（受入 L1091: 発行 → 消化 → 逆仕訳 → 残回数が戻る）
// ---------------------------------------------------------------------------

export interface ReverseTicketParams {
  /** 対象の ticket_entries.id（purchase または redeem 行） */
  entryId: string;
  reason: string;
  now?: Date;
}

export type ReverseTicketOutcome =
  | { kind: "ok"; remainingCount: number; deferredAmount: number }
  | { kind: "not_found" }
  | { kind: "not_reversible"; detail: string }
  | { kind: "already_reversed" };

/**
 * 回数券行の逆仕訳。上書き・削除はせず、打ち消しの reverse 行を追記する。
 * - redeem の逆仕訳: 残回数と前受金が戻り、振替した ticket_redeem 行も
 *   逆仕訳（reversal_of つきの負行）、payments も負行で打ち消す
 * - purchase の逆仕訳: 未消化（残 = 発行数）のときだけ全額打ち消せる
 */
export async function reverseTicketEntryCore(
  sql: Sql,
  session: Session,
  params: ReverseTicketParams,
): Promise<ReverseTicketOutcome> {
  const now = params.now ?? new Date();
  try {
    return await withUser(sql, session, async (tx) => {
      const rows = await tx<
        {
          id: string;
          customer_id: string;
          type: string;
          count: number;
          amount: number;
          reservation_id: string | null;
          lot_id: string | null;
        }[]
      >`
        select id::text as id, customer_id, type::text as type, count, amount,
               reservation_id, lot_id
        from ticket_entries
        where id = ${params.entryId}::bigint
      `;
      const entry = rows[0];
      if (!entry) return { kind: "not_found" } as const;

      // 顧客をロックして並行の消化・逆仕訳と直列化
      await tx`select id from customers where id = ${entry.customer_id}::uuid for update`;

      if (entry.type === "redeem") {
        if (entry.reservation_id === null || entry.lot_id === null) {
          return { kind: "not_reversible", detail: "redeem row missing links" } as const;
        }
        // reverse 行（残回数・前受金を戻す）。二重逆仕訳は
        // ticket_entries_reverse_reservation_uniq が DB 層で拒否
        await tx`
          insert into ticket_entries
            (customer_id, type, count, amount, reservation_id, lot_id, reason,
             occurred_at, created_by)
          values (
            ${entry.customer_id}::uuid, 'reverse', ${-entry.count}, ${-entry.amount},
            ${entry.reservation_id}::uuid, ${entry.lot_id}::bigint,
            ${params.reason}, ${now}, ${session.userId}::uuid
          )
        `;
        // 振替した売上行を逆仕訳（reversal_of つき負行）
        const lineRows = await tx<{ id: string; amount: number }[]>`
          select id::text as id, amount from revenue_lines
          where reservation_id = ${entry.reservation_id}::uuid
            and line_type = 'ticket_redeem' and reversal_of is null
          limit 1
        `;
        const line = lineRows[0];
        if (line) {
          await tx`
            insert into revenue_lines
              (reservation_id, line_type, amount, area_id, therapist_id,
               occurred_at, reversal_of, note, created_by)
            select reservation_id, line_type, ${-line.amount}, area_id, therapist_id,
                   ${now}, id, ${params.reason}, ${session.userId}::uuid
            from revenue_lines where id = ${line.id}::bigint
          `;
          await tx`
            insert into payments (reservation_id, method, amount, occurred_at, note, created_by)
            values (
              ${entry.reservation_id}::uuid, 'ticket', ${-line.amount},
              ${now}, ${params.reason}, ${session.userId}::uuid
            )
          `;
        }
      } else if (entry.type === "purchase") {
        const remRows = await tx<{ remaining: number }[]>`
          select (e.count + coalesce(
            (select sum(c.count) from ticket_entries c where c.lot_id = e.id), 0
          ))::integer as remaining
          from ticket_entries e where e.id = ${entry.id}::bigint
        `;
        const remaining = remRows[0]?.remaining ?? 0;
        if (remaining !== entry.count) {
          return {
            kind: "not_reversible",
            detail: "consumed lot cannot be reversed (reverse the redeems first)",
          } as const;
        }
        await tx`
          insert into ticket_entries
            (customer_id, type, count, amount, lot_id, reason, occurred_at, created_by)
          values (
            ${entry.customer_id}::uuid, 'reverse', ${-entry.count}, ${-entry.amount},
            ${entry.id}::bigint, ${params.reason}, ${now}, ${session.userId}::uuid
          )
        `;
      } else {
        return { kind: "not_reversible", detail: `type=${entry.type}` } as const;
      }

      const bal = await selectTicketBalance(tx, entry.customer_id);
      return {
        kind: "ok",
        remainingCount: bal.remainingCount,
        deferredAmount: bal.deferredAmount,
      } as const;
    });
  } catch (e) {
    if (pgErrorInfo(e).code === "23505") {
      return { kind: "already_reversed" };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 5. 経費（spec L868）
// ---------------------------------------------------------------------------

export interface AddExpenseParams {
  category: ExpenseCategory;
  amount: number;
  /** YYYY-MM-DD（Asia/Tokyo の日付） */
  spentOn: string;
  areaId?: string | null;
  note?: string | null;
}

export async function addExpenseCore(
  sql: Sql,
  session: Session,
  params: AddExpenseParams,
): Promise<{ id: string }> {
  return withUser(sql, session, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into expenses (category, amount, spent_on, area_id, note, created_by)
      values (
        ${params.category}::expense_category, ${params.amount}, ${params.spentOn}::date,
        ${params.areaId ?? null}, ${params.note ?? null}, ${session.userId}::uuid
      )
      returning id
    `;
    const row = rows[0];
    if (!row) throw new Error("expense insert returned no row");
    return { id: row.id };
  });
}

export interface ExpenseItem {
  id: string;
  category: ExpenseCategory;
  amount: number;
  spentOn: string;
  areaId: string | null;
  note: string | null;
}

export async function listExpensesCore(
  sql: Sql,
  session: Session,
  params: { fromDate: string; toDate: string; areaId?: string | null },
): Promise<ExpenseItem[]> {
  return withUser(sql, session, async (tx) => {
    const rows = await tx<
      {
        id: string;
        category: ExpenseCategory;
        amount: number;
        spent_on: string;
        area_id: string | null;
        note: string | null;
      }[]
    >`
      select id, category::text as category, amount,
             to_char(spent_on, 'YYYY-MM-DD') as spent_on, area_id, note
      from expenses
      where spent_on >= ${params.fromDate}::date
        and spent_on < ${params.toDate}::date
        ${params.areaId ? tx`and area_id = ${params.areaId}::uuid` : tx``}
      order by spent_on desc, created_at desc
    `;
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      amount: r.amount,
      spentOn: r.spent_on,
      areaId: r.area_id,
      note: r.note,
    }));
  });
}

/**
 * 経費を1件削除する（G2・日次会計の訂正用）。RLS（staff）で守る。
 * 経費は台帳（revenue_lines/payout_lines）と違い誤入力の訂正が要るため delete を許す
 * （0015 で app_runtime に delete grant 済み）。削除できたら true。
 */
export async function deleteExpenseCore(
  sql: Sql,
  session: Session,
  id: string,
): Promise<boolean> {
  return withUser(sql, session, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      delete from expenses where id = ${id}::uuid returning id
    `;
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// 6. 基本集計（完了条件 L1069: 前受金・ポイント引当・売上・経費が**分けて**出る）
// ---------------------------------------------------------------------------

export interface AccountingSummaryParams {
  /** 期間 [from, to)（timestamptz） */
  from: Date;
  to: Date;
  areaId?: string | null;
  therapistId?: string | null;
}

export interface AccountingSummary {
  /** 売上: revenue_lines **だけ**を読む（spec L858）。負の値引行も含む純額 */
  revenue: { total: number; byType: Record<RevenueLineType, number> };
  /** 支払方法内訳（spec L862） */
  payments: { total: number; byMethod: Record<PaymentMethod, number> };
  /** ポイント引当（負債）。期末（to）時点の全社残。エリア/セラピストでは絞れない */
  pointLiability: PointLiabilityBreakdown;
  /** 前受金（回数券残）。期末（to）時点の全社残 */
  deferredRevenue: { remainingCount: number; deferredAmount: number };
  /** 経費（期間内・エリアで絞れる） */
  expenses: { total: number; byCategory: Record<ExpenseCategory, number> };
  /** 突合（spec 11-6）。payout はフェーズ18 実装まで 0 */
  settlement: Settlement;
}

const REVENUE_TYPES: readonly RevenueLineType[] = [
  "course",
  "option",
  "nomination",
  "transport",
  "midnight",
  "discount",
  "point_use",
  "ticket_redeem",
];
const PAYMENT_METHODS: readonly PaymentMethod[] = [
  "cash",
  "card",
  "emoney",
  "ticket",
  "point",
];
const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  "oil",
  "supplies",
  "parking",
  "ads",
  "other",
];

/**
 * 期間 × エリア × セラピストの基本集計（spec L860-862 のうち台帳側の骨格）。
 * 需要ヒートマップ・CSV・週次レポートはフェーズ19/20。
 */
export async function getAccountingSummaryCore(
  sql: Sql,
  session: Session,
  params: AccountingSummaryParams,
): Promise<AccountingSummary> {
  return withUser(sql, session, async (tx) => {
    // 1. 売上（revenue_lines だけを読む / spec L858）
    const revRows = await tx<{ line_type: RevenueLineType; total: number }[]>`
      select line_type::text as line_type, sum(amount)::integer as total
      from revenue_lines
      where occurred_at >= ${params.from} and occurred_at < ${params.to}
        ${params.areaId ? tx`and area_id = ${params.areaId}::uuid` : tx``}
        ${params.therapistId ? tx`and therapist_id = ${params.therapistId}::uuid` : tx``}
      group by line_type
    `;
    const byType = Object.fromEntries(
      REVENUE_TYPES.map((t) => [t, 0]),
    ) as Record<RevenueLineType, number>;
    for (const row of revRows) byType[row.line_type] = row.total;
    const revenueTotal = REVENUE_TYPES.reduce((s, t) => s + byType[t], 0);

    // 2. 支払方法内訳（エリア/セラピストは予約経由で絞る）
    const payRows = await tx<{ method: PaymentMethod; total: number }[]>`
      select p.method::text as method, sum(p.amount)::integer as total
      from payments p
      join reservations r on r.id = p.reservation_id
      where p.occurred_at >= ${params.from} and p.occurred_at < ${params.to}
        ${params.areaId ? tx`and r.area_id = ${params.areaId}::uuid` : tx``}
        ${params.therapistId ? tx`and r.therapist_id = ${params.therapistId}::uuid` : tx``}
      group by p.method
    `;
    const byMethod = Object.fromEntries(
      PAYMENT_METHODS.map((m) => [m, 0]),
    ) as Record<PaymentMethod, number>;
    for (const row of payRows) byMethod[row.method] = row.total;
    const paymentsTotal = PAYMENT_METHODS.reduce((s, m) => s + byMethod[m], 0);

    // 3. ポイント引当（期末時点の全社残 = 負債。売上とは別枠 / spec L846・L862）
    const liaRows = await tx<
      { earned: number; used: number; expired: number; adjusted: number }[]
    >`
      select
        coalesce(sum(points) filter (where type = 'earn'), 0)::integer as earned,
        coalesce(-sum(points) filter (where type = 'use'), 0)::integer as used,
        coalesce(-sum(points) filter (where type = 'expire'), 0)::integer as expired,
        coalesce(sum(points) filter (where type in ('adjust', 'reverse')), 0)::integer as adjusted
      from point_entries
      where occurred_at < ${params.to}
    `;
    const lia = liaRows[0] ?? { earned: 0, used: 0, expired: 0, adjusted: 0 };
    const liability = pointLiability([
      { type: "earn", points: lia.earned },
      { type: "use", points: -lia.used },
      { type: "expire", points: -lia.expired },
      { type: "adjust", points: lia.adjusted },
    ]);

    // 4. 前受金 = 回数券残（期末時点の全社残 / spec L857・L862）
    const ticketRows = await tx<{ count: number; amount: number }[]>`
      select
        coalesce(sum(count), 0)::integer as count,
        coalesce(sum(amount), 0)::integer as amount
      from ticket_entries
      where occurred_at < ${params.to}
    `;
    const deferred = deferredRevenue(
      ticketRows[0] ? [ticketRows[0]] : [],
    );

    // 5. 経費（spent_on は Asia/Tokyo の日付として比較 / spec L868）
    const expRows = await tx<{ category: ExpenseCategory; total: number }[]>`
      select category::text as category, sum(amount)::integer as total
      from expenses
      where spent_on >= (${params.from}::timestamptz at time zone 'Asia/Tokyo')::date
        and spent_on < (${params.to}::timestamptz at time zone 'Asia/Tokyo')::date
        ${params.areaId ? tx`and area_id = ${params.areaId}::uuid` : tx``}
      group by category
    `;
    const byCategory = Object.fromEntries(
      EXPENSE_CATEGORIES.map((c) => [c, 0]),
    ) as Record<ExpenseCategory, number>;
    for (const row of expRows) byCategory[row.category] = row.total;
    const expensesTotal = EXPENSE_CATEGORIES.reduce((s, c) => s + byCategory[c], 0);

    return {
      revenue: { total: revenueTotal, byType },
      payments: { total: paymentsTotal, byMethod },
      pointLiability: liability,
      deferredRevenue: deferred,
      expenses: { total: expensesTotal, byCategory },
      // 突合の骨組み（spec 11-6）。payout_lines はフェーズ18 で差し込む
      settlement: settlement({ revenue: revenueTotal, payout: 0, expenses: expensesTotal }),
    };
  });
}
