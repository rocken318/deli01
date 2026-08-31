'use server';

/**
 * フェーズ18 報酬 Server Actions（spec 11章 L873-949）。
 *
 * 実体は queries.ts（Session 注入型のコア）。ここは
 *   getDevSession / getTherapistDevSession → Zod 検証 → コア → ActionResult
 * の薄いラッパ（accounting/actions.ts・therapist-portal-actions.ts と同じ構成）。
 * 生の Postgres エラー（RLS 拒否・追記専用違反・締めロック等）は画面に出さない。
 * 金額はすべて整数（円）。calc_note は queries.ts が tx.json で書く
 * （JSON.stringify の二重エンコード禁止）。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession, getTherapistDevSession } from '@/lib/cms/dev-session';
import { loadBookingFees } from '@/lib/booking/holds';
import { loadPayoutSettings } from './policy';
import {
  closePayoutPeriodCore,
  getDailyPayoutsCore,
  getMyEarningsCore,
  getPayoutRatesGridCore,
  markPayoutPaidCore,
  postReservationPayoutCore,
  reversePayoutLineCore,
  upsertPayoutRateCore,
} from './queries';
import type { DailyPayoutsResult, MyEarnings, PayoutRatesGrid } from './queries';
import type { PayoutLineDraft, ReservationPayoutResult } from '@/domain/payout';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD');

// ---------------------------------------------------------------------------
// 1. 予約の報酬計上（施術完了の瞬間に反映 / spec L940）
// ---------------------------------------------------------------------------

const postPayoutSchema = z.object({
  reservationId: z.string().uuid(),
  /** therapist 本人として計上する場合の slug（dev）。省略時は staff セッション */
  asTherapistSlug: z.string().min(1).max(100).optional(),
});

export interface PostReservationPayoutData {
  businessDate: string;
  lines: PayoutLineDraft[];
  unresolved: ReservationPayoutResult['unresolved'];
}

/**
 * 施術完了（done）/ noshow の予約の報酬を payout_lines に計上する。
 * 冪等（二重計上は DB unique が拒否）。締め済み期間へは計上できない（受入 L1094）。
 * 回数券消化でもバックは立つ（spec L917・受入 L1095）。noshow は交通費のみ（L919）。
 */
export async function postReservationPayout(
  input: z.infer<typeof postPayoutSchema>,
): Promise<ActionResult<PostReservationPayoutData>> {
  const parsed = postPayoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  const session = parsed.data.asTherapistSlug
    ? await getTherapistDevSession(parsed.data.asTherapistSlug)
    : await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  try {
    const sql = getClient();
    const [fees, settings] = await Promise.all([
      loadBookingFees(),
      loadPayoutSettings(sql),
    ]);
    const outcome = await postReservationPayoutCore(sql, session, {
      reservationId: parsed.data.reservationId,
      fees,
      settings,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: {
            businessDate: outcome.businessDate,
            lines: outcome.lines,
            unresolved: outcome.unresolved,
          },
        };
      case 'not_found':
        return { ok: false, error: '予約が見つかりません' };
      case 'invalid_status':
        return { ok: false, error: '施術完了（または無断キャンセル）の予約のみ計上できます' };
      case 'already_posted':
        return { ok: false, error: 'この予約は既に報酬計上されています' };
      case 'period_closed':
        return {
          ok: false,
          error: 'この期間は締め済みです。修正は逆仕訳で行ってください',
        };
      case 'inconsistent':
        return { ok: false, error: '金額の内訳が合いません（管理者に連絡してください）' };
    }
  } catch (e) {
    console.error('postReservationPayout failed:', e);
    return { ok: false, error: '報酬の計上に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 2. 逆仕訳（修正は上書きではなく打ち消し行 / spec L921・受入 L1097）
// ---------------------------------------------------------------------------

const reverseSchema = z.object({
  lineId: z.string().regex(/^\d+$/),
  reason: z.string().min(1).max(200),
});

export async function reversePayoutLine(
  input: z.infer<typeof reverseSchema>,
): Promise<ActionResult<{ reversalId: string; businessDate: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = reverseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const outcome = await reversePayoutLineCore(getClient(), session, {
      lineId: parsed.data.lineId,
      reason: parsed.data.reason,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: { reversalId: outcome.reversalId, businessDate: outcome.businessDate },
        };
      case 'not_found':
        return { ok: false, error: '対象の行が見つかりません' };
      case 'not_reversible':
        return { ok: false, error: 'この行は逆仕訳できません' };
      case 'already_reversed':
        return { ok: false, error: 'この行は既に逆仕訳されています' };
      case 'period_closed':
        return { ok: false, error: '当日の期間が締め済みのため逆仕訳できません' };
    }
  } catch (e) {
    console.error('reversePayoutLine failed:', e);
    return { ok: false, error: '逆仕訳に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 3. 締めと支払（spec 11-4）
// ---------------------------------------------------------------------------

const deductionKindSchema = z.enum([
  'advance',
  'supplies',
  'loan',
  'withholding',
  'other',
]);

const closeSchema = z.object({
  therapistId: z.string().uuid(),
  periodStart: dateSchema,
  periodEnd: dateSchema,
  deductions: z
    .array(
      z.object({
        kind: deductionKindSchema,
        amount: z.number().int().positive(),
        note: z.string().max(200).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export interface ClosePayoutData {
  payoutId: string;
  gross: number;
  deductions: number;
  net: number;
  lineCount: number;
}

/**
 * 期間を締めて payouts を確定（status='closed'）しロックする。
 * 以後この期間への計上は拒否され、修正は逆仕訳のみ（受入 L1094・L1097）。
 * 源泉徴収は**既定オフ**（spec L936）。控除する場合は kind='withholding' の
 * 手入力のみ（額の自動判定はやらない / 16章）。
 */
export async function closePayoutPeriod(
  input: z.infer<typeof closeSchema>,
): Promise<ActionResult<ClosePayoutData>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const outcome = await closePayoutPeriodCore(getClient(), session, {
      therapistId: parsed.data.therapistId,
      periodStart: parsed.data.periodStart,
      periodEnd: parsed.data.periodEnd,
      deductions: parsed.data.deductions,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: {
            payoutId: outcome.payoutId,
            gross: outcome.gross,
            deductions: outcome.deductions,
            net: outcome.net,
            lineCount: outcome.lineCount,
          },
        };
      case 'forbidden':
        return { ok: false, error: '締めはオーナー/管理者のみ実行できます' };
      case 'therapist_not_found':
        return { ok: false, error: 'セラピストが見つかりません' };
      case 'overlap':
        return { ok: false, error: 'この期間は既に締められた期間と重なっています' };
      case 'invalid':
        return { ok: false, error: '期間の指定が不正です' };
    }
  } catch (e) {
    console.error('closePayoutPeriod failed:', e);
    return { ok: false, error: '締めに失敗しました' };
  }
}

const markPaidSchema = z.object({ payoutId: z.string().uuid() });

/** 支払実行の記録（closed → paid）。振込の実行はしない（spec 16章） */
export async function markPayoutPaid(
  input: z.infer<typeof markPaidSchema>,
): Promise<ActionResult<{ payoutId: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = markPaidSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const outcome = await markPayoutPaidCore(getClient(), session, {
      payoutId: parsed.data.payoutId,
    });
    switch (outcome.kind) {
      case 'ok':
        return { ok: true, data: { payoutId: outcome.payoutId } };
      case 'not_found':
        return { ok: false, error: '支払が見つかりません' };
      case 'invalid_status':
        return { ok: false, error: '締め済み（closed）の支払のみ記録できます' };
    }
  } catch (e) {
    console.error('markPayoutPaid failed:', e);
    return { ok: false, error: '支払記録に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 4. セラピスト向け即時集計（spec 11-5。本人セッション + RLS / 受入 L1134）
// ---------------------------------------------------------------------------

const myEarningsSchema = z.object({
  from: dateSchema,
  to: dateSchema,
  /** dev なりすまし用 slug（therapist-portal-actions と同じ流儀） */
  asSlug: z.string().min(1).max(100).optional(),
});

/**
 * 今日の稼ぎ・今月見込み・確定額・明細内訳・支払履歴（spec 11-5）。
 * therapist セッションで RLS 経由。他人の報酬は取得できない（受入 L1134）。
 */
export async function getMyEarnings(
  input: z.infer<typeof myEarningsSchema>,
): Promise<ActionResult<MyEarnings>> {
  const parsed = myEarningsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  const session = await getTherapistDevSession(parsed.data.asSlug);
  if (!session) return { ok: false, error: '認証が必要です（セラピスト）' };

  try {
    const outcome = await getMyEarningsCore(getClient(), session, {
      fromDate: parsed.data.from,
      toDate: parsed.data.to,
    });
    if (outcome.kind === 'forbidden') {
      return { ok: false, error: 'セラピスト本人のみ利用できます' };
    }
    return { ok: true, data: outcome.earnings };
  } catch (e) {
    console.error('getMyEarnings failed:', e);
    return { ok: false, error: '報酬の取得に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 5. レートグリッド（spec L386。UI は後続。コアの読み書きのみ）
// ---------------------------------------------------------------------------

export async function getPayoutRatesGrid(): Promise<ActionResult<PayoutRatesGrid>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  try {
    const grid = await getPayoutRatesGridCore(getClient(), session);
    return { ok: true, data: grid };
  } catch (e) {
    console.error('getPayoutRatesGrid failed:', e);
    return { ok: false, error: 'レートの取得に失敗しました' };
  }
}

const upsertRateSchema = z
  .object({
    therapistId: z.string().uuid().nullish(),
    rankId: z.string().uuid().nullish(),
    targetType: z.enum([
      'course',
      'option',
      'nomination',
      'transport',
      'late_night',
      'cancel_fee',
    ]),
    targetId: z.string().uuid().nullish(),
    calcType: z.enum(['fixed', 'rate']),
    value: z.number().int().nonnegative(),
    effectiveFrom: dateSchema,
    note: z.string().max(200).nullish(),
  })
  .refine((v) => !(v.therapistId != null && v.rankId != null), {
    message: '個別レートとランク別レートは同時に指定できません',
  })
  .refine((v) => v.calcType !== 'rate' || v.value <= 100, {
    message: '率は 0〜100 の整数%で指定してください',
  });

/**
 * レートの改定（適用開始日つき / spec L895）。
 * 既存レートは打ち切り（effective_to 設定）のみで値は書き換えない。
 * 過去に確定した報酬は変わらない（受入 L1094）。
 */
export async function upsertPayoutRate(
  input: z.infer<typeof upsertRateSchema>,
): Promise<ActionResult<{ rateId: string; cappedCount: number }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = upsertRateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const outcome = await upsertPayoutRateCore(getClient(), session, {
      therapistId: parsed.data.therapistId ?? null,
      rankId: parsed.data.rankId ?? null,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId ?? null,
      calcType: parsed.data.calcType,
      value: parsed.data.value,
      effectiveFrom: parsed.data.effectiveFrom,
      note: parsed.data.note ?? null,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: { rateId: outcome.rateId, cappedCount: outcome.cappedCount },
        };
      case 'forbidden':
        return { ok: false, error: 'レート編集はオーナー/管理者のみ実行できます' };
      case 'invalid':
        return { ok: false, error: '入力が不正です' };
    }
  } catch (e) {
    console.error('upsertPayoutRate failed:', e);
    return { ok: false, error: 'レートの保存に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 6. 未計上の done/noshow 予約一覧（管理画面の「報酬を計上」導線用）
// ---------------------------------------------------------------------------

export interface UnpostedPayoutReservation {
  id: string;
  startLabel: string;
  therapistName: string;
  therapistId: string;
  therapistSlug: string;
  courseName: string;
  totalAmount: number;
  nominationFee: number;
  transportFee: number;
  status: string;
}

/**
 * 報酬計上済みでない done/noshow 予約一覧。
 * payout_lines に reservation_id が存在しない = 未計上として扱う。
 */
export async function listUnpostedPayoutReservations(): Promise<
  ActionResult<UnpostedPayoutReservation[]>
> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  try {
    const rows = await getClient()<
      {
        id: string;
        start_label: string;
        therapist_name: string | null;
        therapist_id: string;
        therapist_slug: string;
        course_name: string;
        total_amount: number;
        nomination_fee: number;
        transport_fee: number;
        status: string;
      }[]
    >`
      select r.id,
             to_char(r.start_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI')
               as start_label,
             coalesce(er.published->>'name', t.slug) as therapist_name,
             t.id as therapist_id,
             t.slug as therapist_slug,
             c.name as course_name,
             r.total_amount,
             r.nomination_fee,
             r.transport_fee,
             r.status::text as status
      from reservations r
      join therapists t on t.id = r.therapist_id
      join courses c on c.id = r.course_id
      left join entity_records er
             on er.entity = 'therapist' and er.slug = t.slug
      where r.status in ('done', 'noshow')
        and not exists (
          select 1 from payout_lines pl
          where pl.reservation_id = r.id
        )
      order by r.start_at desc
      limit 100
    `;
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        startLabel: r.start_label,
        therapistName: r.therapist_name ?? r.therapist_slug,
        therapistId: r.therapist_id,
        therapistSlug: r.therapist_slug,
        courseName: r.course_name,
        totalAmount: r.total_amount,
        nominationFee: r.nomination_fee,
        transportFee: r.transport_fee,
        status: r.status,
      })),
    };
  } catch (e) {
    console.error('listUnpostedPayoutReservations failed:', e);
    return { ok: false, error: '未計上予約の取得に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 7. 支払一覧（管理画面の締め・支払タブ用）
// ---------------------------------------------------------------------------

export interface PayoutListItem {
  id: string;
  periodStart: string;
  periodEnd: string;
  gross: number;
  deductions: number;
  net: number;
  status: string;
  therapistName: string;
  therapistId: string;
}

export async function listPayouts(): Promise<ActionResult<PayoutListItem[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  try {
    const rows = await getClient()<
      {
        id: string;
        period_start: string;
        period_end: string;
        gross: number;
        deductions: number;
        net: number;
        status: string;
        therapist_name: string | null;
        therapist_id: string;
      }[]
    >`
      select p.id,
             to_char(p.period_start, 'YYYY-MM-DD') as period_start,
             to_char(p.period_end,   'YYYY-MM-DD') as period_end,
             p.gross, p.deductions, p.net,
             p.status::text as status,
             coalesce(er.published->>'name', t.slug) as therapist_name,
             t.id as therapist_id
      from payouts p
      join therapists t on t.id = p.therapist_id
      left join entity_records er
             on er.entity = 'therapist' and er.slug = t.slug
      order by p.period_start desc
      limit 50
    `;
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        gross: r.gross,
        deductions: r.deductions,
        net: r.net,
        status: r.status,
        therapistName: r.therapist_name ?? r.therapist_id,
        therapistId: r.therapist_id,
      })),
    };
  } catch (e) {
    console.error('listPayouts failed:', e);
    return { ok: false, error: '支払一覧の取得に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 8. 日払い用: 当日分のセラピスト別バック集計
// ---------------------------------------------------------------------------

const dailyPayoutsSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD'),
});

/**
 * 指定業務日（Asia/Tokyo）のセラピスト別バック集計。
 * 認証ゲートは listUnpostedPayoutReservations / listPayouts と同じ。
 */
export async function getDailyPayouts(
  input: z.infer<typeof dailyPayoutsSchema>,
): Promise<ActionResult<DailyPayoutsResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = dailyPayoutsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '日付は YYYY-MM-DD 形式で指定してください' };

  try {
    const result = await getDailyPayoutsCore(getClient(), session, {
      businessDate: parsed.data.businessDate,
    });
    return { ok: true, data: result };
  } catch (e) {
    console.error('getDailyPayouts failed:', e);
    return { ok: false, error: '当日分バックの取得に失敗しました' };
  }
}

export type { DailyPayoutsResult, MyEarnings, PayoutRatesGrid };
