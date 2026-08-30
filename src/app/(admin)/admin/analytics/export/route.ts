import { type NextRequest, NextResponse } from 'next/server';
import { getDevSession } from '@/lib/cms/dev-session';
import { getClient } from '@/lib/db-client';
import { withUser } from '@/lib/auth/with-user';

/**
 * フェーズ19 集計 CSV エクスポート Route Handler（spec 19章）。
 *
 * GET /admin/analytics/export?from=<ISO>&to=<ISO>&type=reconciliation|revenue|payout
 *
 * - UTF-8 BOM 付き CSV（Excel で直接開ける）
 * - 金額はすべて整数（円）
 * - type=reconciliation : エリア別突合（売上/バック/経費/粗利/予約件数/客単価）
 * - type=revenue        : 売上明細（revenue_lines）上限10,000行
 * - type=payout         : 報酬明細（payout_lines）上限10,000行
 *   TODO(全銀厳密化): payout は現在 CSV 簡易形式。全銀固定長フォーマットへの変換は別途対応
 */

// ---------------------------------------------------------------------------
// 内部型（クエリ結果行）
// ---------------------------------------------------------------------------

interface ReconciliationRow {
  area_name: string | null;
  revenue: number;
  payout: number;
  expenses: number;
  res_count: number;
}

interface RevenueLineRow {
  occurred_at: Date;
  area_name: string | null;
  therapist_name: string | null;
  line_type: string;
  amount: number;
}

interface PayoutLineRow {
  business_date: string;
  therapist_name: string | null;
  category: string;
  amount: number;
  note: string | null;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getDevSession();
  if (!session) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const fromISO = searchParams.get('from');
  const toISO = searchParams.get('to');
  const type = searchParams.get('type') ?? 'reconciliation';

  if (!fromISO || !toISO) {
    return new NextResponse('from/to required', { status: 400 });
  }

  const from = new Date(fromISO);
  const to = new Date(toISO);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
    return new NextResponse('invalid date range', { status: 400 });
  }

  if (!['reconciliation', 'revenue', 'payout'].includes(type)) {
    return new NextResponse('unknown type', { status: 400 });
  }

  // UTF-8 BOM（Excel で直接開いたときに文字化けしない）
  const BOM = '﻿';
  let csv = BOM;

  const sql = getClient();
  try {
    if (type === 'reconciliation') {
      csv += 'エリア,売上合計,バック合計,経費合計,粗利,予約件数,客単価\n';
      const rows = await withUser(sql, session, async (tx) => {
        return tx<ReconciliationRow[]>`
          with rev as (
            select rl.area_id,
                   sum(rl.amount)::integer as revenue,
                   count(distinct rl.reservation_id)::integer as res_count
            from revenue_lines rl
            where rl.occurred_at >= ${from}
              and rl.occurred_at < ${to}
            group by rl.area_id
          ),
          pay as (
            select r.area_id, sum(pl.amount)::integer as payout
            from payout_lines pl
            join reservations r on r.id = pl.reservation_id
            where pl.business_date >= (${from}::timestamptz at time zone 'Asia/Tokyo')::date
              and pl.business_date < (${to}::timestamptz at time zone 'Asia/Tokyo')::date
              and pl.reversal_of is null
            group by r.area_id
          ),
          exp as (
            select area_id, sum(amount)::integer as expenses
            from expenses
            where spent_on >= (${from}::timestamptz at time zone 'Asia/Tokyo')::date
              and spent_on < (${to}::timestamptz at time zone 'Asia/Tokyo')::date
            group by area_id
          )
          select
            coalesce(a.name, '（エリア不明）') as area_name,
            coalesce(rev.revenue, 0) as revenue,
            coalesce(pay.payout, 0) as payout,
            coalesce(exp.expenses, 0) as expenses,
            coalesce(rev.res_count, 0) as res_count
          from (
            select distinct area_id
            from revenue_lines
            where occurred_at >= ${from}
              and occurred_at < ${to}
          ) base
          left join areas a on a.id = base.area_id
          left join rev on rev.area_id = base.area_id
          left join pay on pay.area_id = base.area_id
          left join exp on exp.area_id = base.area_id
          order by a.name asc nulls last
        `;
      });
      for (const r of rows) {
        const gross = r.revenue - r.payout - r.expenses;
        const avg = r.res_count > 0 ? Math.floor(r.revenue / r.res_count) : 0;
        csv +=
          `${csvEscape(r.area_name ?? '')},${r.revenue},${r.payout},${r.expenses},${gross},${r.res_count},${avg}\n`;
      }
    } else if (type === 'revenue') {
      csv += '日時,エリア,セラピスト,明細種別,金額\n';
      const rows = await withUser(sql, session, async (tx) => {
        return tx<RevenueLineRow[]>`
          select
            rl.occurred_at,
            a.name as area_name,
            coalesce(er.published->>'name', t.slug) as therapist_name,
            rl.line_type::text as line_type,
            rl.amount
          from revenue_lines rl
          left join areas a on a.id = rl.area_id
          left join therapists t on t.id = rl.therapist_id
          left join entity_records er
            on er.entity = 'therapist'
            and er.slug = t.slug
          where rl.occurred_at >= ${from}
            and rl.occurred_at < ${to}
          order by rl.occurred_at asc, rl.id asc
          limit 10000
        `;
      });
      for (const r of rows) {
        const dt = r.occurred_at.toLocaleString('ja-JP', {
          timeZone: 'Asia/Tokyo',
        });
        csv +=
          `${csvEscape(dt)},${csvEscape(r.area_name ?? '')},${csvEscape(r.therapist_name ?? '')},${csvEscape(r.line_type)},${r.amount}\n`;
      }
    } else {
      // type === 'payout'
      // TODO(全銀厳密化): 現在は CSV 簡易形式。全銀固定長フォーマットへの変換は別途対応
      csv += '営業日,セラピスト,区分,金額,備考\n';
      const rows = await withUser(sql, session, async (tx) => {
        return tx<PayoutLineRow[]>`
          select
            pl.business_date::text as business_date,
            coalesce(er.published->>'name', t.slug) as therapist_name,
            pl.category::text as category,
            pl.amount,
            pl.note
          from payout_lines pl
          join therapists t on t.id = pl.therapist_id
          left join entity_records er
            on er.entity = 'therapist'
            and er.slug = t.slug
          where pl.business_date >= (${from}::timestamptz at time zone 'Asia/Tokyo')::date
            and pl.business_date < (${to}::timestamptz at time zone 'Asia/Tokyo')::date
            and pl.reversal_of is null
          order by pl.business_date asc, t.slug asc, pl.id asc
          limit 10000
        `;
      });
      for (const r of rows) {
        csv +=
          `${csvEscape(r.business_date)},${csvEscape(r.therapist_name ?? '')},${csvEscape(r.category)},${r.amount},${csvEscape(r.note ?? '')}\n`;
      }
    }
  } catch (e) {
    console.error('CSV export failed:', e);
    return new NextResponse('サーバーエラー', { status: 500 });
  }

  const safeFrom = fromISO.substring(0, 10);
  const safeTo = toISO.substring(0, 10);
  const filename = `${type}_${safeFrom}_${safeTo}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
