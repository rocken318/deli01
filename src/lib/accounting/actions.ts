'use server';

/**
 * フェーズ17 会計 Server Actions（spec 10章 L853-869・9章 L844-849・11-6）。
 *
 * 実体は queries.ts（Session 注入型のコア）。ここは
 *   getDevSession → Zod 検証 → コア呼び出し → ActionResult 変換
 * の薄いラッパ（points/actions.ts と同じ構成）。
 * 生の Postgres エラー（RLS 拒否・追記専用違反・unique 違反等）は画面に出さず
 * 汎用文言に変換する。金額はすべて整数（円）。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { loadBookingFees } from '@/lib/booking/holds';
import type { RevenueLineDraft, PointLiabilityBreakdown, BooksPeriod } from '@/domain/accounting';
import { businessDayRange } from '@/domain/accounting';
import {
  addExpenseCore,
  getAccountingSummaryCore,
  listExpensesCore,
  postReservationRevenueCore,
  redeemTicketCore,
  reverseTicketEntryCore,
  sellTicketCore,
} from './queries';
import type { AccountingSummary, ExpenseItem } from './queries';
import { getDailyBooksCore } from './daily-books';
import type { DailyBooksResult } from './daily-books';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const phoneSchema = z.string().regex(/^0[0-9]{9,10}$/, '電話番号の形式が不正です');

const customerRefSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    phone: phoneSchema.optional(),
  })
  .refine((v) => v.customerId != null || v.phone != null, {
    message: '顧客IDか電話番号のどちらかが必要です',
  });

// 支払方法は spec L855 の 現金/カード/電子マネー/回数券 のみ。ポイントは支払でなく
// point_use（値引）で表現するため payments には受け付けない（reviewer S6・二重表現防止）。
const paymentMethodSchema = z.enum(['cash', 'card', 'emoney', 'ticket']);

// ---------------------------------------------------------------------------
// 1. 予約の売上計上
// ---------------------------------------------------------------------------

const postRevenueSchema = z.object({
  reservationId: z.string().uuid(),
  /** 支払方法の内訳（併用可 / spec L855）。省略時は記録しない */
  payments: z
    .array(
      z.object({
        method: paymentMethodSchema,
        amount: z.number().int().positive(),
      }),
    )
    .max(10)
    .optional(),
});

export interface PostRevenueData {
  lines: RevenueLineDraft[];
  pointsUsed: number;
  ticketPaid: boolean;
}

/**
 * 施術完了（done）した予約の売上を revenue_lines に独立行で計上する（spec L856）。
 * 冪等: 二重計上は事前チェック + DB の部分 unique で拒否される。
 * ポイント利用済みならマイナスの point_use 行が自動で立つ（spec L847）。
 * 回数券消化（redeemTicket）を先に済ませた予約は course 行の代わりに
 * 振替（ticket_redeem）だけが売上になる。
 */
export async function postReservationRevenue(
  input: z.infer<typeof postRevenueSchema>,
): Promise<ActionResult<PostRevenueData>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = postRevenueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const fees = await loadBookingFees();
    const outcome = await postReservationRevenueCore(getClient(), session, {
      reservationId: parsed.data.reservationId,
      fees,
      payments: parsed.data.payments,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: {
            lines: outcome.lines,
            pointsUsed: outcome.pointsUsed,
            ticketPaid: outcome.ticketPaid,
          },
        };
      case 'not_found':
        return { ok: false, error: '予約が見つかりません' };
      case 'not_done':
        return { ok: false, error: '施術完了（done）の予約のみ計上できます' };
      case 'already_posted':
        return { ok: false, error: 'この予約は既に売上計上されています' };
      case 'inconsistent':
        return { ok: false, error: '金額の内訳が合いません（管理者に連絡してください）' };
    }
  } catch (e) {
    console.error('postReservationRevenue failed:', e);
    return { ok: false, error: '売上計上に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 2. 回数券
// ---------------------------------------------------------------------------

const sellTicketSchema = customerRefSchema.and(
  z
    .object({
      count: z.number().int().positive().max(100),
      /** 券面総額（円）。unitPrice とどちらか一方を指定 */
      totalAmount: z.number().int().nonnegative().optional(),
      /** 名目単価（円）。指定時は totalAmount = count × unitPrice */
      unitPrice: z.number().int().nonnegative().optional(),
      expiresAtISO: z.string().datetime({ offset: true }).optional(),
      reason: z.string().max(200).optional(),
    })
    .refine((v) => (v.totalAmount != null) !== (v.unitPrice != null), {
      message: '券面総額か単価のどちらか一方を指定してください',
    }),
);

export interface TicketBalanceData {
  remainingCount: number;
  deferredAmount: number;
}

/**
 * 回数券の発行（purchase 行 = **前受金**）。売上には計上しない（spec L857）。
 * 売上になるのは消化（redeemTicket）時の振替のみ。
 */
export async function sellTicket(
  input: z.infer<typeof sellTicketSchema>,
): Promise<ActionResult<TicketBalanceData & { entryId: string; customerId: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = sellTicketSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  const totalAmount =
    parsed.data.totalAmount ?? parsed.data.count * (parsed.data.unitPrice ?? 0);

  try {
    const outcome = await sellTicketCore(getClient(), session, {
      customerId: parsed.data.customerId,
      phone: parsed.data.phone,
      count: parsed.data.count,
      totalAmount,
      unitPrice: parsed.data.unitPrice ?? null,
      expiresAt: parsed.data.expiresAtISO ? new Date(parsed.data.expiresAtISO) : null,
      reason: parsed.data.reason,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: {
            entryId: outcome.entryId,
            customerId: outcome.customerId,
            remainingCount: outcome.remainingCount,
            deferredAmount: outcome.deferredAmount,
          },
        };
      case 'customer_not_found':
        return { ok: false, error: '顧客が見つかりません' };
      case 'invalid':
        return { ok: false, error: '入力が不正です' };
    }
  } catch (e) {
    console.error('sellTicket failed:', e);
    return { ok: false, error: '回数券の発行に失敗しました' };
  }
}

const redeemTicketSchema = customerRefSchema.and(
  z.object({ reservationId: z.string().uuid() }),
);

export interface RedeemTicketData extends TicketBalanceData {
  lotId: string;
  /** 前受金から売上へ振り替えた額（端数配分後の円） */
  redeemAmount: number;
}

/**
 * 回数券の消化。FIFO で1回分を消化し、前受金からの振替（ticket_redeem の
 * revenue_line）と支払内訳（method='ticket'）を同時に記録する。
 * 同一予約への二重消化は DB の unique が拒否する。
 */
export async function redeemTicket(
  input: z.infer<typeof redeemTicketSchema>,
): Promise<ActionResult<RedeemTicketData>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = redeemTicketSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const outcome = await redeemTicketCore(getClient(), session, {
      customerId: parsed.data.customerId,
      phone: parsed.data.phone,
      reservationId: parsed.data.reservationId,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: {
            lotId: outcome.lotId,
            redeemAmount: outcome.redeemAmount,
            remainingCount: outcome.remainingCount,
            deferredAmount: outcome.deferredAmount,
          },
        };
      case 'customer_not_found':
        return { ok: false, error: '顧客が見つかりません' };
      case 'reservation_not_found':
        return { ok: false, error: '予約が見つかりません' };
      case 'customer_mismatch':
        return { ok: false, error: 'この予約は別の顧客のものです' };
      case 'invalid_status':
        return { ok: false, error: '確定前の予約には使えません' };
      case 'no_ticket':
        return { ok: false, error: '利用可能な回数券がありません' };
      case 'already_redeemed':
        return { ok: false, error: 'この予約には既に回数券が使われています' };
      case 'course_already_posted':
        return {
          ok: false,
          error: 'この予約は現金売上で計上済みです（先に売上を取り消してください）',
        };
      case 'invalid':
        return { ok: false, error: '入力が不正です' };
    }
  } catch (e) {
    console.error('redeemTicket failed:', e);
    return { ok: false, error: '回数券の消化に失敗しました' };
  }
}

const reverseTicketSchema = z.object({
  entryId: z.string().regex(/^\d+$/),
  reason: z.string().min(1).max(200),
});

/**
 * 回数券行の逆仕訳（受入 L1091: 発行 → 消化 → 逆仕訳 → 残回数が戻る）。
 * redeem の逆仕訳は振替済みの売上行・支払内訳も同時に打ち消す。
 */
export async function reverseTicketEntry(
  input: z.infer<typeof reverseTicketSchema>,
): Promise<ActionResult<TicketBalanceData>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = reverseTicketSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const outcome = await reverseTicketEntryCore(getClient(), session, {
      entryId: parsed.data.entryId,
      reason: parsed.data.reason,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: {
            remainingCount: outcome.remainingCount,
            deferredAmount: outcome.deferredAmount,
          },
        };
      case 'not_found':
        return { ok: false, error: '対象の行が見つかりません' };
      case 'not_reversible':
        return { ok: false, error: 'この行は逆仕訳できません' };
      case 'already_reversed':
        return { ok: false, error: 'この行は既に逆仕訳されています' };
    }
  } catch (e) {
    console.error('reverseTicketEntry failed:', e);
    return { ok: false, error: '逆仕訳に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 3. 経費（spec L868）
// ---------------------------------------------------------------------------

const expenseCategorySchema = z.enum(['oil', 'supplies', 'parking', 'ads', 'other']);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD');

const addExpenseSchema = z.object({
  category: expenseCategorySchema,
  amount: z.number().int().positive(),
  spentOn: dateSchema,
  areaId: z.string().uuid().nullish(),
  note: z.string().max(500).nullish(),
});

/** 経費の入力（オイル・備品・駐車場代・広告費 / spec L868） */
export async function addExpense(
  input: z.infer<typeof addExpenseSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = addExpenseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const result = await addExpenseCore(getClient(), session, {
      category: parsed.data.category,
      amount: parsed.data.amount,
      spentOn: parsed.data.spentOn,
      areaId: parsed.data.areaId ?? null,
      note: parsed.data.note ?? null,
    });
    return { ok: true, data: result };
  } catch (e) {
    console.error('addExpense failed:', e);
    return { ok: false, error: '経費の登録に失敗しました' };
  }
}

const listExpensesSchema = z.object({
  /** [fromDate, toDate) の半開区間（YYYY-MM-DD） */
  fromDate: dateSchema,
  toDate: dateSchema,
  areaId: z.string().uuid().nullish(),
});

export async function listExpenses(
  input: z.infer<typeof listExpensesSchema>,
): Promise<ActionResult<ExpenseItem[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = listExpensesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const items = await listExpensesCore(getClient(), session, {
      fromDate: parsed.data.fromDate,
      toDate: parsed.data.toDate,
      areaId: parsed.data.areaId ?? null,
    });
    return { ok: true, data: items };
  } catch (e) {
    console.error('listExpenses failed:', e);
    return { ok: false, error: '経費の取得に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// G 日次会計（受付表の確認用 / SGS 形）: 営業日（06:00 JST 境界）の日/週/月ロールアップ
// ---------------------------------------------------------------------------

const dailyBooksSchema = z.object({
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period: z.enum(['day', 'week', 'month']),
});

export interface DailyBooksView extends DailyBooksResult {
  label: string;
  period: BooksPeriod;
  anchorDate: string;
  /** 経費入力/一覧に使う暦日範囲（半開 [fromDate, toDate)） */
  fromDate: string;
  toDate: string;
}

/**
 * 営業日（06:00 JST 境界）× 期間（日/週/月）の日次会計を返す。
 * 売上/バック/経費/粗利・個人別・支払方法内訳（読み取り専用・締めロックなし）。
 * RLS（owner/admin）で守る。
 */
export async function getDailyBooks(
  input: z.infer<typeof dailyBooksSchema>,
): Promise<ActionResult<DailyBooksView>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = dailyBooksSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const range = businessDayRange(parsed.data.dateISO, parsed.data.period);
    const core = await getDailyBooksCore(getClient(), session, range);
    return {
      ok: true,
      data: {
        ...core,
        label: range.label,
        period: range.period,
        anchorDate: range.anchorDate,
        fromDate: range.fromDate,
        toDate: range.toDate,
      },
    };
  } catch (e) {
    console.error('getDailyBooks failed:', e);
    return { ok: false, error: '日次会計の取得に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 4. 基本集計（完了条件 L1069: 前受金・ポイント引当・売上・経費が分けて出る）
// ---------------------------------------------------------------------------

const summarySchema = z.object({
  /** 期間 [from, to)（ISO 8601） */
  fromISO: z.string().datetime({ offset: true }),
  toISO: z.string().datetime({ offset: true }),
  areaId: z.string().uuid().nullish(),
  therapistId: z.string().uuid().nullish(),
});

/**
 * 期間 × エリア × セラピストの基本集計。
 * 売上（revenue_lines のみ / spec L858）・支払方法内訳・ポイント引当・
 * 前受金（回数券残）・経費を**別々の枠で**返す。突合（11-6）の骨組みつき
 * （バックはフェーズ18 まで 0）。
 */
export async function getAccountingSummary(
  input: z.infer<typeof summarySchema>,
): Promise<ActionResult<AccountingSummary>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = summarySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  const from = new Date(parsed.data.fromISO);
  const to = new Date(parsed.data.toISO);
  if (!(from.getTime() < to.getTime())) {
    return { ok: false, error: '期間の指定が不正です' };
  }

  try {
    const summary = await getAccountingSummaryCore(getClient(), session, {
      from,
      to,
      areaId: parsed.data.areaId ?? null,
      therapistId: parsed.data.therapistId ?? null,
    });
    return { ok: true, data: summary };
  } catch (e) {
    console.error('getAccountingSummary failed:', e);
    return { ok: false, error: '集計の取得に失敗しました' };
  }
}

export type { AccountingSummary, ExpenseItem, PointLiabilityBreakdown };

// ---------------------------------------------------------------------------
// 5. 未計上の完了予約一覧（計上導線 / spec L856）
// ---------------------------------------------------------------------------

export interface UnpostedReservation {
  id: string;
  customerName: string | null;
  therapistName: string | null;
  courseName: string;
  startAtISO: string;
  totalAmount: number;
}

/**
 * status='done' かつ revenue_lines 未生成（course/ticket_redeem 行がない）の予約一覧。
 * 計上導線（postReservationRevenue）への入口として使う。
 */
export async function listUnpostedDoneReservations(): Promise<
  ActionResult<UnpostedReservation[]>
> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  try {
    const rows = await getClient()<
      {
        id: string;
        customer_name: string | null;
        therapist_name: string | null;
        course_name: string;
        start_at: Date;
        total_amount: number;
      }[]
    >`
      select r.id,
             c.name as customer_name,
             er.published->>'name' as therapist_name,
             co.name as course_name,
             r.start_at,
             r.total_amount
      from reservations r
      left join customers c on c.id = r.customer_id
      left join therapists t on t.id = r.therapist_id
      left join entity_records er
             on er.entity = 'therapist' and er.slug = t.slug
      join courses co on co.id = r.course_id
      where r.status = 'done'
        and not exists (
          select 1 from revenue_lines rl
          where rl.reservation_id = r.id
            and rl.line_type in ('course', 'ticket_redeem', 'option',
                                 'nomination', 'transport', 'midnight', 'point_use')
            and rl.reversal_of is null
        )
      order by r.start_at desc
      limit 100
    `;
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        customerName: r.customer_name,
        therapistName: r.therapist_name,
        courseName: r.course_name,
        startAtISO: r.start_at.toISOString(),
        totalAmount: r.total_amount,
      })),
    };
  } catch (e) {
    console.error('listUnpostedDoneReservations failed:', e);
    return { ok: false, error: '未計上予約の取得に失敗しました' };
  }
}
