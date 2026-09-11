'use server';

/**
 * 当日給料（日払い精算）Server Actions（設計 4.8/5.5）。
 * payout_lines を読んで集計し daily_payouts へ精算記録を追記する。
 * 既存の報酬エンジン（payout_lines/payout_rates）は書き換えない。
 * 金額はすべて整数（円）。雑費は floor（切り捨て確定）。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { computeDayPay } from '@/domain/payout/day-pay';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface DayPayLine { category: string; amount: number; }
export interface TodaysPayRow {
  therapistId: string; therapistName: string; lines: DayPayLine[];
  gross: number; misc: number; pay: number; settled: boolean; paidAt: string | null;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD');

// ---------------------------------------------------------------------------
// 雑費率の読み取り（site_settings.payout_policy.misc_deduction_rate 既定10）
// ---------------------------------------------------------------------------

async function loadMiscRate(): Promise<number> {
  const rows = await getClient()<{ value: unknown }[]>`
    select value from site_settings where key = 'payout_policy' limit 1
  `;
  const raw = rows[0]?.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 10;
  const o = raw as Record<string, unknown>;
  const rate = o['misc_deduction_rate'];
  return typeof rate === 'number' && Number.isInteger(rate) && rate >= 0 ? rate : 10;
}

// ---------------------------------------------------------------------------
// 1. getTodaysPay: 当日バック集計（therapist ごとに内訳+精算状態）
// ---------------------------------------------------------------------------

export async function getTodaysPay(
  dateISO: string,
): Promise<ActionResult<TodaysPayRow[]>> {
  const parsedDate = dateSchema.safeParse(dateISO);
  if (!parsedDate.success) return { ok: false, error: '日付は YYYY-MM-DD' };

  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限がありません' };
  }

  try {
    const sql = getClient();
    const [miscRate, rows, settled] = await withUser(sql, session, async (tx) => {
      const rate = await loadMiscRate();

      // payout_lines 集計: business_date の therapist × category 別合計
      const lines = await tx<{
        therapist_id: string;
        therapist_name: string;
        category: string;
        amount: number;
      }[]>`
        select
          pl.therapist_id,
          coalesce(er.published->>'name', t.slug) as therapist_name,
          pl.category::text as category,
          sum(pl.amount)::integer as amount
        from payout_lines pl
        join therapists t on t.id = pl.therapist_id
        left join entity_records er
               on er.entity = 'therapist' and er.slug = t.slug
        where pl.business_date = ${parsedDate.data}::date
        group by pl.therapist_id, pl.category, t.slug, er.published
        order by pl.therapist_id, pl.category
      `;

      // daily_payouts の存在確認
      const dps = await tx<{
        therapist_id: string;
        paid_at: string;
      }[]>`
        select therapist_id, to_char(paid_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') as paid_at
        from daily_payouts
        where business_date = ${parsedDate.data}::date
      `;

      return [rate, lines, dps] as const;
    });

    // therapist ごとにグループ化
    const byTherapist = new Map<string, { name: string; lines: DayPayLine[] }>();
    for (const row of rows) {
      if (!byTherapist.has(row.therapist_id)) {
        byTherapist.set(row.therapist_id, { name: row.therapist_name, lines: [] });
      }
      byTherapist.get(row.therapist_id)!.lines.push({ category: row.category, amount: row.amount });
    }

    const settledMap = new Map<string, string>(settled.map((d) => [d.therapist_id, d.paid_at]));

    const data: TodaysPayRow[] = Array.from(byTherapist.entries()).map(([therapistId, info]) => {
      const gross = info.lines.reduce((s, l) => s + l.amount, 0);
      const { misc, pay } = computeDayPay(gross, miscRate);
      const paidAt = settledMap.get(therapistId) ?? null;
      return {
        therapistId,
        therapistName: info.name,
        lines: info.lines,
        gross,
        misc,
        pay,
        settled: paidAt !== null,
        paidAt,
      };
    });

    return { ok: true, data };
  } catch (e) {
    console.error('getTodaysPay failed:', e);
    return { ok: false, error: '当日給料の取得に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 2. settleTodaysPay: 精算記録（on conflict do nothing で冪等）
// ---------------------------------------------------------------------------

const settleSchema = z.object({
  therapistId: z.string().uuid(),
  dateISO: dateSchema,
});

export async function settleTodaysPay(
  input: z.infer<typeof settleSchema>,
): Promise<ActionResult<{ already: boolean }>> {
  const parsed = settleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限がありません' };
  }

  try {
    const sql = getClient();
    const result = await withUser(sql, session, async (tx) => {
      const miscRate = await loadMiscRate();

      // 当日のこのセラピストの gross を集計
      const lines = await tx<{ amount: number }[]>`
        select sum(amount)::integer as amount
        from payout_lines
        where therapist_id = ${parsed.data.therapistId}::uuid
          and business_date = ${parsed.data.dateISO}::date
        group by therapist_id
      `;
      const gross = lines[0]?.amount ?? 0;
      const { misc, pay: net } = computeDayPay(gross, miscRate);

      // insert … on conflict do nothing
      const inserted = await tx<{ id: string }[]>`
        insert into daily_payouts (therapist_id, business_date, gross, misc, net, paid_by)
        values (
          ${parsed.data.therapistId}::uuid,
          ${parsed.data.dateISO}::date,
          ${gross},
          ${misc},
          ${net},
          ${session.userId}::uuid
        )
        on conflict (therapist_id, business_date) do nothing
        returning id
      `;

      return inserted.length === 0 ? { already: true } : { already: false };
    });

    return { ok: true, data: result };
  } catch (e) {
    console.error('settleTodaysPay failed:', e);
    return { ok: false, error: '精算の記録に失敗しました' };
  }
}
