import "server-only";
import type postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { midnightSurcharge as midnightFee } from "@/domain/booking";
import type { BookingFeeSettings } from "@/domain/booking";
import {
  buildReservationPayout,
  settlePayoutPeriod,
} from "@/domain/payout";
import type {
  PayoutCalcType,
  PayoutCategory,
  PayoutLineDraft,
  PayoutRate,
  PayoutSettings,
  PayoutTargetType,
  ReservationPayoutResult,
} from "@/domain/payout";

/**
 * フェーズ18 報酬の中核（spec 11章 L873-949）。
 * Server Action（actions.ts）から Session を受け取って動く
 * （accounting/queries.ts と同じ Session 注入型。統合テストはここへ直接渡す）。
 *
 * 台帳の規約（migrations/0016 の設計ノートと対）:
 * - payout_lines は追記専用（update/delete は grant なし）。修正は逆仕訳の追記のみ
 * - 二重計上は DB の部分 unique（singleton/option/reversal）が最終防衛線
 * - **過去不変（受入 L1094・L1097）**: 締め済み（closed/paid）期間への行追加は
 *   DB トリガ（payout_lines_period_lock / errcode P0018）が拒否する。
 *   レート改定は新しい行にしか影響しない（計上済み行は calc_note のスナップショット）
 * - 逆仕訳は**当日の business_date** で積む（open 期間に入る。締め済み payouts の
 *   保存値 gross/net は動かさない = 過去の明細が変わらない）
 * - revenue_lines とは独立して積む（spec L949）。基礎額は予約のスナップショット
 *   （total_amount 残差・reservation_options.price_snapshot 等）から取り、
 *   売上台帳から導出しない
 */

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

export type PayoutDeductionKind =
  | "advance"
  | "supplies"
  | "loan"
  | "withholding"
  | "other";

const PAYOUT_CATEGORIES: readonly PayoutCategory[] = [
  "course",
  "option",
  "nomination",
  "transport",
  "late_night",
  "cancel_fee",
  "adjustment",
];

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

/** now の Asia/Tokyo 日付（'YYYY-MM-DD'）を DB で確定する（文字列で日時計算しない） */
async function jstDateOf(tx: TransactionSql, at: Date): Promise<string> {
  const rows = await tx<{ d: string }[]>`
    select to_char(${at}::timestamptz at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as d
  `;
  const d = rows[0]?.d;
  if (!d) throw new Error("jst date resolution failed");
  return d;
}

/** その日に適用され得るレート候補を読む（絞り込みの正は domain/payout の resolveRate） */
async function selectCandidateRates(
  tx: TransactionSql,
  therapistId: string,
  businessDate: string,
): Promise<PayoutRate[]> {
  const rows = await tx<
    {
      id: string;
      therapist_id: string | null;
      rank_id: string | null;
      target_type: PayoutTargetType;
      target_id: string | null;
      calc_type: PayoutCalcType;
      value: number;
      effective_from: string;
      effective_to: string | null;
    }[]
  >`
    select id, therapist_id, rank_id,
           target_type::text as target_type, target_id,
           calc_type::text as calc_type, value,
           to_char(effective_from, 'YYYY-MM-DD') as effective_from,
           to_char(effective_to, 'YYYY-MM-DD') as effective_to
    from payout_rates
    where (therapist_id is null or therapist_id = ${therapistId}::uuid)
      and effective_from <= ${businessDate}::date
      and (effective_to is null or effective_to > ${businessDate}::date)
  `;
  return rows.map((r) => ({
    id: r.id,
    therapistId: r.therapist_id,
    rankId: r.rank_id,
    targetType: r.target_type,
    targetId: r.target_id,
    calcType: r.calc_type,
    value: r.value,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  }));
}

/**
 * その日（dayISO・JST）の「予定（見込み）報酬」を概算する。
 * 対象は当日の**未計上**予約（confirmed/enroute/in_service/done で payout_lines 未作成）。
 * 実計上（postReservationPayoutCore）と同じ入力・同じ buildReservationPayout で outcome='done'
 * として算出し、行合計を積む（読み取りのみ・挿入しない）。不整合な予約はスキップ。
 */
async function sumScheduledPayout(
  tx: TransactionSql,
  therapistId: string,
  dayISO: string,
  settings: PayoutSettings,
  fees: Parameters<typeof midnightFee>[1],
): Promise<number> {
  const resRows = await tx<
    {
      id: string;
      start_at: Date;
      course_id: string;
      nomination_fee: number;
      transport_fee: number;
      total_amount: number;
    }[]
  >`
    select r.id, r.start_at, r.course_id, r.nomination_fee, r.transport_fee, r.total_amount
    from reservations r
    where r.therapist_id = ${therapistId}::uuid
      and (r.start_at at time zone 'Asia/Tokyo')::date = ${dayISO}::date
      and r.status in ('confirmed', 'enroute', 'in_service', 'done')
      and not exists (
        select 1 from payout_lines pl
        where pl.reservation_id = r.id
          and pl.category <> 'adjustment' and pl.reversal_of is null
      )
  `;
  if (resRows.length === 0) return 0;

  const rates = await selectCandidateRates(tx, therapistId, dayISO);
  const tRow = await tx<{ rank_id: string | null }[]>`
    select rank_id from therapists where id = ${therapistId}::uuid
  `;
  const rankId = tRow[0]?.rank_id ?? null;

  let total = 0;
  for (const r of resRows) {
    const optionRows = await tx<
      { option_id: string; price_snapshot: number; name: string | null }[]
    >`
      select ro.option_id, ro.price_snapshot, o.name
      from reservation_options ro
      left join options o on o.id = ro.option_id
      where ro.reservation_id = ${r.id}::uuid
      order by ro.created_at, ro.option_id
    `;
    const optionsTotal = optionRows.reduce((s, o) => s + o.price_snapshot, 0);
    const midnight = midnightFee(r.start_at, fees);
    const coursePrice =
      r.total_amount - optionsTotal - r.nomination_fee - r.transport_fee - midnight;
    if (coursePrice < 0) continue; // 不整合はスキップ（予定は概算）

    const discRows = await tx<{ total: number }[]>`
      select coalesce(-sum(amount), 0)::integer as total
      from revenue_lines
      where reservation_id = ${r.id}::uuid and line_type = 'discount' and reversal_of is null
    `;
    const discountAmount = discRows[0]?.total ?? 0;
    const pointRows = await tx<{ used: number }[]>`
      select coalesce(-sum(points), 0)::integer as used
      from point_entries where reservation_id = ${r.id}::uuid and type = 'use'
    `;
    const pointsUsed = pointRows[0]?.used ?? 0;
    const ticketRows = await tx<{ redeemed: number; reversed: number }[]>`
      select count(*) filter (where type = 'redeem')::int as redeemed,
             count(*) filter (where type = 'reverse')::int as reversed
      from ticket_entries where reservation_id = ${r.id}::uuid
    `;
    const paidByTicket =
      (ticketRows[0]?.redeemed ?? 0) > 0 && (ticketRows[0]?.reversed ?? 0) === 0;

    const { lines } = buildReservationPayout({
      reservation: {
        therapistId,
        rankId,
        businessDate: dayISO,
        outcome: "done",
        courseId: r.course_id,
        coursePrice,
        options: optionRows.map((o) => ({
          optionId: o.option_id,
          price: o.price_snapshot,
          ...(o.name !== null ? { label: o.name } : {}),
        })),
        nominationFee: r.nomination_fee,
        transportFee: r.transport_fee,
        lateNightFee: midnight,
        discountAmount,
        pointsUsed,
        paidByTicket,
      },
      rates,
      settings,
    });
    total += lines.reduce((s, l) => s + l.amount, 0);
  }
  return total;
}

async function insertPayoutLine(
  tx: TransactionSql,
  params: {
    therapistId: string;
    businessDate: string;
    reservationId: string | null;
    line: PayoutLineDraft;
    createdBy: string;
  },
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    insert into payout_lines
      (therapist_id, business_date, reservation_id, category, option_id,
       amount, calc_note, created_by)
    values (
      ${params.therapistId}::uuid,
      ${params.businessDate}::date,
      ${params.reservationId},
      ${params.line.category}::payout_category,
      ${params.line.optionId ?? null},
      ${params.line.amount},
      ${tx.json(params.line.calcNote as unknown as postgres.JSONValue)},
      ${params.createdBy}::uuid
    )
    returning id::text as id
  `;
  const row = rows[0];
  if (!row) throw new Error("payout_line insert returned no row");
  return row.id;
}

// ---------------------------------------------------------------------------
// 1. 予約の報酬計上（spec 11-2・11-3）
// ---------------------------------------------------------------------------

export interface PostReservationPayoutParams {
  reservationId: string;
  /** CMS の料金設定（深夜加算の再計算に使う）。actions.ts が loadBookingFees で渡す */
  fees: BookingFeeSettings;
  /** バック基礎の設定。actions.ts が loadPayoutSettings で渡す */
  settings: PayoutSettings;
  now?: Date;
}

export type PostReservationPayoutOutcome =
  | {
      kind: "ok";
      businessDate: string;
      lines: PayoutLineDraft[];
      lineIds: string[];
      /** レート未設定で報酬が立たなかった対象（運用上の警告。黙って握り潰さない） */
      unresolved: ReservationPayoutResult["unresolved"];
    }
  | { kind: "not_found" }
  | { kind: "invalid_status"; status: string }
  | { kind: "already_posted" }
  | { kind: "period_closed" }
  | { kind: "inconsistent"; detail: string };

/**
 * 施術完了（done）または noshow の予約の報酬を payout_lines に計上する。
 *
 * - done: course/option/nomination/transport/late_night を独立行で
 * - noshow: 交通費のみ（spec L919 既定）
 * - **回数券消化でもバックは立つ**（spec L917・受入 L1095）。基礎はコース定価
 *   （total_amount の残差 = 値引前）。現金の有無では分岐しない
 * - 値引（revenue_lines の discount 行）・ポイント利用（point_entries の use 行）は
 *   settings（既定: 値引前基礎）に応じて course の基礎から控除
 * - 冪等: 既計上なら already_posted（並行実行は DB の部分 unique が最終防衛線）
 * - 締め済み期間の予約は period_closed（DB トリガ P0018 が最終防衛線 / 受入 L1094）
 */
export async function postReservationPayoutCore(
  sql: Sql,
  session: Session,
  params: PostReservationPayoutParams,
): Promise<PostReservationPayoutOutcome> {
  try {
    return await withUser(sql, session, async (tx) => {
      const resRows = await tx<
        {
          id: string;
          status: string;
          start_at: Date;
          business_date: string;
          therapist_id: string;
          course_id: string;
          nomination_fee: number;
          transport_fee: number;
          total_amount: number;
        }[]
      >`
        select r.id, r.status::text as status, r.start_at,
               to_char(r.start_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as business_date,
               r.therapist_id, r.course_id,
               r.nomination_fee, r.transport_fee, r.total_amount
        from reservations r
        where r.id = ${params.reservationId}::uuid
        for update
      `;
      const r = resRows[0];
      if (!r) return { kind: "not_found" } as const;
      if (r.status !== "done" && r.status !== "noshow") {
        return { kind: "invalid_status", status: r.status } as const;
      }

      // 締め済み期間の事前判定（文言のため。最終防衛線は DB トリガ P0018）
      const closed = await tx<{ n: number }[]>`
        select count(*)::int as n from payouts p
        where p.therapist_id = ${r.therapist_id}::uuid
          and p.status in ('closed', 'paid')
          and ${r.business_date}::date between p.period_start and p.period_end
      `;
      if ((closed[0]?.n ?? 0) > 0) return { kind: "period_closed" } as const;

      // 既計上の事前判定（最終防衛線は payout_lines の部分 unique）
      const existing = await tx<{ n: number }[]>`
        select count(*)::int as n from payout_lines
        where reservation_id = ${r.id}::uuid
          and category <> 'adjustment'
          and reversal_of is null
      `;
      if ((existing[0]?.n ?? 0) > 0) return { kind: "already_posted" } as const;

      // ランク（レート既定値の解決に使う / spec 18-4）
      const tRows = await tx<{ rank_id: string | null }[]>`
        select rank_id from therapists where id = ${r.therapist_id}::uuid
      `;
      const rankId = tRows[0]?.rank_id ?? null;

      // コース名（calc_note の表示用ラベル）
      const cRows = await tx<{ name: string }[]>`
        select name from courses where id = ${r.course_id}::uuid
      `;
      const courseLabel = cRows[0]?.name;

      // オプション（予約時点のスナップショット / spec 3-4）
      const optionRows = await tx<
        { option_id: string; price_snapshot: number; name: string | null }[]
      >`
        select ro.option_id, ro.price_snapshot, o.name
        from reservation_options ro
        left join options o on o.id = ro.option_id
        where ro.reservation_id = ${r.id}::uuid
        order by ro.created_at, ro.option_id
      `;
      const optionsTotal = optionRows.reduce((s, o) => s + o.price_snapshot, 0);

      // コース定価 = total_amount の残差（0015 の売上計上と同じ規約。
      // courses.price の後変更に影響されない値引前のスナップショット）
      const midnight = midnightFee(r.start_at, params.fees);
      const coursePrice =
        r.total_amount - optionsTotal - r.nomination_fee - r.transport_fee - midnight;
      if (coursePrice < 0) {
        return {
          kind: "inconsistent",
          detail: `course residual ${coursePrice} < 0 (total=${r.total_amount})`,
        } as const;
      }

      // 値引（直前割等 = revenue_lines の discount 行。負で記帳 → 正の大きさへ）
      const discRows = await tx<{ total: number }[]>`
        select coalesce(-sum(amount), 0)::integer as total
        from revenue_lines
        where reservation_id = ${r.id}::uuid
          and line_type = 'discount' and reversal_of is null
      `;
      const discountAmount = discRows[0]?.total ?? 0;

      // ポイント利用（use 行は負 → 正の大きさへ）
      const pointRows = await tx<{ used: number }[]>`
        select coalesce(-sum(points), 0)::integer as used
        from point_entries
        where reservation_id = ${r.id}::uuid and type = 'use'
      `;
      const pointsUsed = pointRows[0]?.used ?? 0;

      // 回数券消化か（redeem 済みかつ未取消。バック発生の有無は変えない / L917）
      const ticketRows = await tx<{ redeemed: number; reversed: number }[]>`
        select
          count(*) filter (where type = 'redeem')::int as redeemed,
          count(*) filter (where type = 'reverse')::int as reversed
        from ticket_entries
        where reservation_id = ${r.id}::uuid
      `;
      const paidByTicket =
        (ticketRows[0]?.redeemed ?? 0) > 0 && (ticketRows[0]?.reversed ?? 0) === 0;

      const rates = await selectCandidateRates(tx, r.therapist_id, r.business_date);

      const { lines, unresolved } = buildReservationPayout({
        reservation: {
          therapistId: r.therapist_id,
          rankId,
          businessDate: r.business_date,
          outcome: r.status === "noshow" ? "noshow" : "done",
          courseId: r.course_id,
          coursePrice,
          ...(courseLabel !== undefined ? { courseLabel } : {}),
          options: optionRows.map((o) => ({
            optionId: o.option_id,
            price: o.price_snapshot,
            ...(o.name !== null ? { label: o.name } : {}),
          })),
          nominationFee: r.nomination_fee,
          transportFee: r.transport_fee,
          lateNightFee: midnight,
          discountAmount,
          pointsUsed,
          paidByTicket,
        },
        rates,
        settings: params.settings,
      });

      const lineIds: string[] = [];
      for (const line of lines) {
        lineIds.push(
          await insertPayoutLine(tx, {
            therapistId: r.therapist_id,
            businessDate: r.business_date,
            reservationId: r.id,
            line,
            createdBy: session.userId,
          }),
        );
      }

      return {
        kind: "ok",
        businessDate: r.business_date,
        lines,
        lineIds,
        unresolved,
      } as const;
    });
  } catch (e) {
    const info = pgErrorInfo(e);
    if (info.code === "23505") return { kind: "already_posted" };
    if (info.code === "P0018") return { kind: "period_closed" };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 2. 逆仕訳（spec L921: 修正は逆仕訳のみ）
// ---------------------------------------------------------------------------

export interface ReversePayoutLineParams {
  /** 対象の payout_lines.id */
  lineId: string;
  reason: string;
  now?: Date;
}

export type ReversePayoutLineOutcome =
  | { kind: "ok"; reversalId: string; businessDate: string }
  | { kind: "not_found" }
  | { kind: "not_reversible"; detail: string }
  | { kind: "already_reversed" }
  | { kind: "period_closed" };

/**
 * 報酬行の逆仕訳。上書き・削除はせず、負の打ち消し行を追記する。
 * business_date は**当日（Asia/Tokyo）**: open 期間に積まれるため、
 * 締め済み payouts の保存値は動かない（受入 L1094・L1097 の両立）。
 * 二重逆仕訳は DB の unique(reversal_of) が拒否する。
 */
export async function reversePayoutLineCore(
  sql: Sql,
  session: Session,
  params: ReversePayoutLineParams,
): Promise<ReversePayoutLineOutcome> {
  const now = params.now ?? new Date();
  try {
    return await withUser(sql, session, async (tx) => {
      const rows = await tx<
        {
          id: string;
          therapist_id: string;
          reservation_id: string | null;
          category: PayoutCategory;
          option_id: string | null;
          amount: number;
          calc_note: unknown;
          reversal_of: string | null;
        }[]
      >`
        select id::text as id, therapist_id, reservation_id,
               category::text as category, option_id, amount, calc_note,
               reversal_of::text as reversal_of
        from payout_lines
        where id = ${params.lineId}::bigint
      `;
      const line = rows[0];
      if (!line) return { kind: "not_found" } as const;
      if (line.reversal_of !== null) {
        return { kind: "not_reversible", detail: "reversal row" } as const;
      }

      const businessDate = await jstDateOf(tx, now);
      const inserted = await tx<{ id: string }[]>`
        insert into payout_lines
          (therapist_id, business_date, reservation_id, category, option_id,
           amount, calc_note, reversal_of, note, created_by)
        values (
          ${line.therapist_id}::uuid,
          ${businessDate}::date,
          ${line.reservation_id},
          ${line.category}::payout_category,
          ${line.option_id},
          ${-line.amount},
          ${tx.json({
            reversalOf: line.id,
            reason: params.reason,
            original: line.calc_note,
          } as unknown as postgres.JSONValue)},
          ${line.id}::bigint,
          ${params.reason},
          ${session.userId}::uuid
        )
        returning id::text as id
      `;
      const rev = inserted[0];
      if (!rev) throw new Error("payout reversal insert returned no row");
      return { kind: "ok", reversalId: rev.id, businessDate } as const;
    });
  } catch (e) {
    const info = pgErrorInfo(e);
    if (info.code === "23505") return { kind: "already_reversed" };
    if (info.code === "P0018") return { kind: "period_closed" };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 3. 締め（spec 11-4）: 期間を集計して payouts を closed で確定・ロック
// ---------------------------------------------------------------------------

export interface ClosePayoutPeriodParams {
  therapistId: string;
  /** 期間は日付の閉区間 [periodStart, periodEnd]（'YYYY-MM-DD'） */
  periodStart: string;
  periodEnd: string;
  /** 控除（立替・備品・貸付・源泉の手入力 / spec L930・L936） */
  deductions?: ReadonlyArray<{
    kind: PayoutDeductionKind;
    amount: number;
    note?: string;
  }>;
  now?: Date;
}

export type ClosePayoutPeriodOutcome =
  | {
      kind: "ok";
      payoutId: string;
      gross: number;
      deductions: number;
      net: number;
      lineCount: number;
    }
  | { kind: "forbidden" }
  | { kind: "therapist_not_found" }
  | { kind: "overlap" }
  | { kind: "invalid"; detail: string };

/**
 * 期間を締める。payout_lines を集計し payouts を status='closed' で確定する。
 * - 以後、この期間への行追加は DB トリガが拒否（受入 L1094）。修正は逆仕訳のみ
 *   （当日日付で open 期間へ / 受入 L1097）
 * - 期間の重複はセラピスト単位の exclusion 制約が拒否（overlap）
 * - インボイス登録番号・源泉フラグを therapists からスナップショット（spec L935-936。
 *   源泉の**額**は自動判定しない = 16章。控除 kind='withholding' の手入力のみ）
 */
export async function closePayoutPeriodCore(
  sql: Sql,
  session: Session,
  params: ClosePayoutPeriodParams,
): Promise<ClosePayoutPeriodOutcome> {
  if (session.role !== "owner" && session.role !== "admin") {
    return { kind: "forbidden" };
  }
  if (params.periodEnd < params.periodStart) {
    return { kind: "invalid", detail: "period_end < period_start" };
  }
  const now = params.now ?? new Date();
  try {
    return await withUser(sql, session, async (tx) => {
      // セラピスト行をロックして同時の締めを直列化 + スナップショット取得
      const tRows = await tx<
        { id: string; invoice_reg_no: string | null; withholding: boolean }[]
      >`
        select id, invoice_reg_no, withholding
        from therapists where id = ${params.therapistId}::uuid
        for update
      `;
      const therapist = tRows[0];
      if (!therapist) return { kind: "therapist_not_found" } as const;

      const lineRows = await tx<{ amount: number }[]>`
        select amount from payout_lines
        where therapist_id = ${params.therapistId}::uuid
          and business_date >= ${params.periodStart}::date
          and business_date <= ${params.periodEnd}::date
      `;
      const deductionList = (params.deductions ?? []).map((d) => ({
        amount: d.amount,
      }));
      const settled = settlePayoutPeriod({
        lines: lineRows,
        deductions: deductionList,
      });

      // exclusion（重複期間）はこの insert で検知される
      const pRows = await tx<{ id: string }[]>`
        insert into payouts
          (therapist_id, period_start, period_end, status, created_by)
        values (
          ${params.therapistId}::uuid,
          ${params.periodStart}::date, ${params.periodEnd}::date,
          'open', ${session.userId}::uuid
        )
        returning id
      `;
      const payout = pRows[0];
      if (!payout) throw new Error("payout insert returned no row");

      for (const d of params.deductions ?? []) {
        await tx`
          insert into payout_deductions (payout_id, kind, amount, note, created_by)
          values (
            ${payout.id}::uuid, ${d.kind}::payout_deduction_kind,
            ${d.amount}, ${d.note ?? null}, ${session.userId}::uuid
          )
        `;
      }

      await tx`
        update payouts
        set gross = ${settled.gross},
            deductions = ${settled.deductions},
            net = ${settled.net},
            status = 'closed',
            closed_at = ${now},
            invoice_reg_no = ${therapist.invoice_reg_no},
            withholding = ${therapist.withholding}
        where id = ${payout.id}::uuid
      `;

      return {
        kind: "ok",
        payoutId: payout.id,
        gross: settled.gross,
        deductions: settled.deductions,
        net: settled.net,
        lineCount: settled.lineCount,
      } as const;
    });
  } catch (e) {
    if (pgErrorInfo(e).code === "23P01") return { kind: "overlap" };
    throw e;
  }
}

export type MarkPayoutPaidOutcome =
  | { kind: "ok"; payoutId: string }
  | { kind: "not_found" }
  | { kind: "invalid_status"; status: string };

/** 支払実行の記録（closed → paid。振込自体はやらない / spec 16章） */
export async function markPayoutPaidCore(
  sql: Sql,
  session: Session,
  params: { payoutId: string; now?: Date },
): Promise<MarkPayoutPaidOutcome> {
  if (session.role !== "owner" && session.role !== "admin") {
    return { kind: "not_found" };
  }
  const now = params.now ?? new Date();
  return withUser(sql, session, async (tx) => {
    const rows = await tx<{ id: string; status: string }[]>`
      select id, status::text as status from payouts
      where id = ${params.payoutId}::uuid
      for update
    `;
    const p = rows[0];
    if (!p) return { kind: "not_found" } as const;
    if (p.status !== "closed") {
      return { kind: "invalid_status", status: p.status } as const;
    }
    await tx`
      update payouts set status = 'paid', paid_at = ${now}
      where id = ${params.payoutId}::uuid
    `;
    return { kind: "ok", payoutId: p.id } as const;
  });
}

// ---------------------------------------------------------------------------
// 4. セラピスト向け即時集計（spec 11-5。RLS 経由 = 他人の報酬は取れない / L1134）
// ---------------------------------------------------------------------------

export interface PayoutSummaryItem {
  id: string;
  periodStart: string;
  periodEnd: string;
  gross: number;
  deductions: number;
  net: number;
  status: "open" | "closed" | "paid";
  closedAtISO: string | null;
  paidAtISO: string | null;
}

export interface MyEarnings {
  /** その日（asOf）の確定済み報酬＝計上済み payout_lines。施術完了→計上で増える（spec L940） */
  todayTotal: number;
  /**
   * その日（asOf）の予定（見込み）＝まだ計上されていない当日予約
   * （confirmed/enroute/in_service/done で payout_lines 未作成）を outcome='done' で
   * 概算した報酬合計。rates/settings/fees を渡したときのみ算出（未指定は 0）。
   */
  scheduledTotal: number;
  /** 今月（1日〜今日）の見込み（未締め分も含む台帳純額） */
  monthToDateTotal: number;
  /** 確定額 = 締め済み（closed/paid）payouts の net 合計 */
  confirmedNetTotal: number;
  /** 指定期間の明細内訳（コース・指名・オプション・交通費が分かれて見える） */
  range: {
    from: string;
    to: string;
    total: number;
    byCategory: Record<PayoutCategory, number>;
  };
  /** 過去の支払履歴 */
  payouts: PayoutSummaryItem[];
}

export type MyEarningsOutcome =
  | { kind: "ok"; earnings: MyEarnings }
  | { kind: "forbidden" };

/**
 * セラピスト本人の報酬サマリ（spec 11-5）。
 * therapist セッションの RLS 経由で読む: payout_lines / payouts の
 * therapist_read ポリシーが「自分の行のみ」を強制する（受入 L1134）。
 * クエリ側の therapist_id 条件は明示するが、防衛線は RLS。
 */
export async function getMyEarningsCore(
  sql: Sql,
  session: Session,
  params: {
    fromDate: string;
    toDate: string;
    now?: Date;
    asOfDate?: string;
    /** 予定（見込み）算出に使う。actions が loadPayoutSettings / loadBookingFees で渡す。 */
    settings?: PayoutSettings;
    fees?: Parameters<typeof midnightFee>[1];
  },
): Promise<MyEarningsOutcome> {
  if (session.role !== "therapist" || !session.therapistId) {
    return { kind: "forbidden" };
  }
  const therapistId = session.therapistId;
  const now = params.now ?? new Date();

  return withUser(sql, session, async (tx) => {
    // 基準日（asOfDate 指定時はその日を「その日」として日次・月内累計を出す）。
    // 過去/未来の日をマイページで見たとき、その日の報酬を正しく出すため。
    const today = params.asOfDate ?? (await jstDateOf(tx, now));
    const monthStart = `${today.slice(0, 7)}-01`;

    // 予定（見込み）: その日の未計上予約を outcome='done' で概算（rates/settings/fees 必須）
    const scheduledTotal =
      params.settings && params.fees
        ? await sumScheduledPayout(tx, therapistId, today, params.settings, params.fees)
        : 0;

    const quick = await tx<{ today_total: number; month_total: number }[]>`
      select
        coalesce(sum(amount) filter (where business_date = ${today}::date), 0)::integer
          as today_total,
        coalesce(sum(amount) filter (
          where business_date >= ${monthStart}::date
            and business_date <= ${today}::date
        ), 0)::integer as month_total
      from payout_lines
      where therapist_id = ${therapistId}::uuid
    `;

    const catRows = await tx<{ category: PayoutCategory; total: number }[]>`
      select category::text as category, sum(amount)::integer as total
      from payout_lines
      where therapist_id = ${therapistId}::uuid
        and business_date >= ${params.fromDate}::date
        and business_date <= ${params.toDate}::date
      group by category
    `;
    const byCategory = Object.fromEntries(
      PAYOUT_CATEGORIES.map((c) => [c, 0]),
    ) as Record<PayoutCategory, number>;
    for (const row of catRows) byCategory[row.category] = row.total;
    const rangeTotal = PAYOUT_CATEGORIES.reduce((s, c) => s + byCategory[c], 0);

    const payoutRows = await tx<
      {
        id: string;
        period_start: string;
        period_end: string;
        gross: number;
        deductions: number;
        net: number;
        status: "open" | "closed" | "paid";
        closed_at: Date | null;
        paid_at: Date | null;
      }[]
    >`
      select id,
             to_char(period_start, 'YYYY-MM-DD') as period_start,
             to_char(period_end, 'YYYY-MM-DD') as period_end,
             gross, deductions, net, status::text as status, closed_at, paid_at
      from payouts
      where therapist_id = ${therapistId}::uuid
      order by period_start desc
      limit 24
    `;
    const confirmedNetTotal = payoutRows
      .filter((p) => p.status !== "open")
      .reduce((s, p) => s + p.net, 0);

    return {
      kind: "ok",
      earnings: {
        todayTotal: quick[0]?.today_total ?? 0,
        scheduledTotal,
        monthToDateTotal: quick[0]?.month_total ?? 0,
        confirmedNetTotal,
        range: {
          from: params.fromDate,
          to: params.toDate,
          total: rangeTotal,
          byCategory,
        },
        payouts: payoutRows.map((p) => ({
          id: p.id,
          periodStart: p.period_start,
          periodEnd: p.period_end,
          gross: p.gross,
          deductions: p.deductions,
          net: p.net,
          status: p.status,
          closedAtISO: p.closed_at ? p.closed_at.toISOString() : null,
          paidAtISO: p.paid_at ? p.paid_at.toISOString() : null,
        })),
      },
    } as const;
  });
}

// ---------------------------------------------------------------------------
// 5. レートグリッド（spec L386。UI は後続フェーズ。コアだけ用意）
// ---------------------------------------------------------------------------

export interface PayoutRateRow extends PayoutRate {
  note: string | null;
}

export interface PayoutRatesGrid {
  ranks: Array<{ id: string; name: string; sortOrder: number }>;
  therapists: Array<{
    id: string;
    slug: string;
    rankId: string | null;
    invoiceRegNo: string | null;
    withholding: boolean;
  }>;
  rates: PayoutRateRow[];
}

/** レート一覧（縦セラピスト × 横レート種別のグリッドの材料）。staff 用 */
export async function getPayoutRatesGridCore(
  sql: Sql,
  session: Session,
): Promise<PayoutRatesGrid> {
  return withUser(sql, session, async (tx) => {
    const ranks = await tx<{ id: string; name: string; sort_order: number }[]>`
      select id, name, sort_order from therapist_ranks order by sort_order, name
    `;
    const therapists = await tx<
      {
        id: string;
        slug: string;
        rank_id: string | null;
        invoice_reg_no: string | null;
        withholding: boolean;
      }[]
    >`
      select id, slug, rank_id, invoice_reg_no, withholding
      from therapists
      where status <> 'retired'
      order by display_order, slug
    `;
    const rates = await tx<
      {
        id: string;
        therapist_id: string | null;
        rank_id: string | null;
        target_type: PayoutTargetType;
        target_id: string | null;
        calc_type: PayoutCalcType;
        value: number;
        effective_from: string;
        effective_to: string | null;
        note: string | null;
      }[]
    >`
      select id, therapist_id, rank_id,
             target_type::text as target_type, target_id,
             calc_type::text as calc_type, value,
             to_char(effective_from, 'YYYY-MM-DD') as effective_from,
             to_char(effective_to, 'YYYY-MM-DD') as effective_to,
             note
      from payout_rates
      order by target_type, effective_from desc
    `;
    return {
      ranks: ranks.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order })),
      therapists: therapists.map((t) => ({
        id: t.id,
        slug: t.slug,
        rankId: t.rank_id,
        invoiceRegNo: t.invoice_reg_no,
        withholding: t.withholding,
      })),
      rates: rates.map((r) => ({
        id: r.id,
        therapistId: r.therapist_id,
        rankId: r.rank_id,
        targetType: r.target_type,
        targetId: r.target_id,
        calcType: r.calc_type,
        value: r.value,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        note: r.note,
      })),
    };
  });
}

export interface UpsertPayoutRateParams {
  /** 個別レート。rankId と排他。両方 null = 既定レート */
  therapistId?: string | null;
  rankId?: string | null;
  targetType: PayoutTargetType;
  targetId?: string | null;
  calcType: PayoutCalcType;
  /** fixed: 円 / rate: 整数%（0〜100） */
  value: number;
  /** 適用開始日。**過去に確定した報酬は変わらない**（スナップショット + 締めロック） */
  effectiveFrom: string;
  note?: string | null;
}

export type UpsertPayoutRateOutcome =
  | { kind: "ok"; rateId: string; cappedCount: number }
  | { kind: "forbidden" }
  | { kind: "invalid"; detail: string };

/**
 * レートの改定（spec L895 の運用形）。
 * 同スコープ・同対象の無期限レートを effective_from で打ち切り（effective_to を設定）、
 * 新しいレート行を追加する。**既存行の value は書き換えない**（履歴が残る）。
 * 計上済み payout_lines は calc_note のスナップショットなので影響を受けない（L1094）。
 */
export async function upsertPayoutRateCore(
  sql: Sql,
  session: Session,
  params: UpsertPayoutRateParams,
): Promise<UpsertPayoutRateOutcome> {
  if (session.role !== "owner" && session.role !== "admin") {
    return { kind: "forbidden" };
  }
  const therapistId = params.therapistId ?? null;
  const rankId = params.rankId ?? null;
  if (therapistId !== null && rankId !== null) {
    return { kind: "invalid", detail: "therapistId and rankId are exclusive" };
  }
  if (!Number.isSafeInteger(params.value) || params.value < 0) {
    return { kind: "invalid", detail: "value must be a non-negative integer" };
  }
  if (params.calcType === "rate" && params.value > 100) {
    return { kind: "invalid", detail: "rate must be 0..100 (integer %)" };
  }

  return withUser(sql, session, async (tx) => {
    // 先行レートの打ち切り（履歴保存。value の上書きはしない）
    const capped = await tx<{ id: string }[]>`
      update payout_rates
      set effective_to = ${params.effectiveFrom}::date
      where target_type = ${params.targetType}::payout_target_type
        and target_id is not distinct from ${params.targetId ?? null}
        and therapist_id is not distinct from ${therapistId}
        and rank_id is not distinct from ${rankId}
        and effective_from < ${params.effectiveFrom}::date
        and (effective_to is null or effective_to > ${params.effectiveFrom}::date)
      returning id
    `;
    const inserted = await tx<{ id: string }[]>`
      insert into payout_rates
        (therapist_id, rank_id, target_type, target_id, calc_type, value,
         effective_from, note, created_by)
      values (
        ${therapistId}, ${rankId},
        ${params.targetType}::payout_target_type, ${params.targetId ?? null},
        ${params.calcType}::payout_calc_type, ${params.value},
        ${params.effectiveFrom}::date, ${params.note ?? null},
        ${session.userId}::uuid
      )
      returning id
    `;
    const row = inserted[0];
    if (!row) throw new Error("payout_rate insert returned no row");
    return { kind: "ok", rateId: row.id, cappedCount: capped.length } as const;
  });
}

// ---------------------------------------------------------------------------
// 6. 日払い用: 当日分のセラピスト別バック集計（spec 管理画面 daily-payouts）
// ---------------------------------------------------------------------------

export interface DailyPayoutRow {
  therapistId: string;
  therapistName: string;
  /** payout_lines の当日合計（整数円） */
  postedTotal: number;
  /** payout_lines の当日行数 */
  lineCount: number;
  /** done/noshow だが payout_lines 未生成の件数 */
  unpostedCount: number;
}

export interface DailyPayoutsResult {
  businessDate: string;
  rows: DailyPayoutRow[];
  /** postedTotal の合計（整数円） */
  grandTotal: number;
}

/**
 * 指定業務日（Asia/Tokyo）のセラピスト別バック集計。
 * - payout_lines の business_date = businessDate の合計を therapist ごとに返す
 * - 加えて「その日に done/noshow になったが payout_lines 未生成」の件数も返す
 * - postedTotal=0 かつ unpostedCount=0 のセラピストは除外（当日稼働のみ）
 * - postedTotal 降順
 */
export async function getDailyPayoutsCore(
  sql: Sql,
  session: Session,
  params: { businessDate: string },
): Promise<DailyPayoutsResult> {
  return withUser(sql, session, async (tx) => {
    // ---- 1. payout_lines の当日集計 ----
    const lineRows = await tx<
      {
        therapist_id: string;
        therapist_name: string | null;
        posted_total: number;
        line_count: number;
      }[]
    >`
      select
        t.id as therapist_id,
        coalesce(er.published->>'name', t.slug) as therapist_name,
        coalesce(sum(pl.amount), 0)::integer as posted_total,
        count(pl.id)::integer as line_count
      from therapists t
      left join entity_records er
             on er.entity = 'therapist' and er.slug = t.slug
      left join payout_lines pl
             on pl.therapist_id = t.id
            and pl.business_date = ${params.businessDate}::date
      where t.status <> 'retired'
      group by t.id, er.published, t.slug
    `;

    // ---- 2. 未計上（done/noshow だが payout_lines 未生成）の件数 ----
    const unpostedRows = await tx<
      { therapist_id: string; unposted_count: number }[]
    >`
      select
        r.therapist_id,
        count(*)::integer as unposted_count
      from reservations r
      where r.status in ('done', 'noshow')
        and (r.start_at at time zone 'Asia/Tokyo')::date = ${params.businessDate}::date
        and not exists (
          select 1 from payout_lines pl
          where pl.reservation_id = r.id
        )
      group by r.therapist_id
    `;

    const unpostedMap = new Map<string, number>();
    for (const u of unpostedRows) {
      unpostedMap.set(u.therapist_id, u.unposted_count);
    }

    const rows: DailyPayoutRow[] = lineRows
      .map((r) => ({
        therapistId: r.therapist_id,
        therapistName: r.therapist_name ?? r.therapist_id,
        postedTotal: r.posted_total,
        lineCount: r.line_count,
        unpostedCount: unpostedMap.get(r.therapist_id) ?? 0,
      }))
      .filter((r) => r.postedTotal !== 0 || r.unpostedCount !== 0)
      .sort((a, b) => b.postedTotal - a.postedTotal);

    const grandTotal = rows.reduce((s, r) => s + r.postedTotal, 0);

    return { businessDate: params.businessDate, rows, grandTotal };
  });
}
