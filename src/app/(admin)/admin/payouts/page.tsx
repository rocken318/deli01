/**
 * 報酬管理ページ（フェーズ18 / spec 11章 L873-949）。
 * 管理側なので日本語直書き可。spec 12-2 デザイントークン準拠。
 * force-dynamic: DB 読取のため毎リクエスト実行。
 */

import type { Metadata } from 'next';
import { getDevSession } from '@/lib/cms/dev-session';
import { getClient } from '@/lib/db-client';
import { getPayoutRatesGrid } from '@/lib/payout/actions';
import { PayoutsClient } from './PayoutsClient';

export const metadata: Metadata = { title: '報酬管理' };
export const dynamic = 'force-dynamic';

interface TherapistOption {
  id: string;
  name: string;
  slug: string;
}

interface UnpostedRow {
  id: string;
  start_label: string;
  therapist_name: string;
  therapist_id: string;
  therapist_slug: string;
  course_name: string;
  total_amount: number;
  nomination_fee: number;
  transport_fee: number;
  status: string;
}

interface PayoutQueryRow {
  id: string;
  period_start: string;
  period_end: string;
  gross: number;
  deductions: number;
  net: number;
  status: string;
  therapist_name: string;
  therapist_id: string;
}

async function loadPageData() {
  const session = await getDevSession();
  if (!session) return { error: '認証が必要です' };

  const sql = getClient();

  const [therapistRows, ratesResult, unpostedRows, payoutsRows] = await Promise.all([
    sql<{ id: string; name: string; slug: string }[]>`
      select t.id, coalesce(er.published->>'name', t.slug) as name, t.slug
      from therapists t
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      where t.status = 'active'
      order by t.display_order asc
    `.catch(() => [] as { id: string; name: string; slug: string }[]),

    getPayoutRatesGrid(),

    sql<UnpostedRow[]>`
      select r.id,
             to_char(r.start_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') as start_label,
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
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      where r.status in ('done', 'noshow')
        and not exists (
          select 1 from payout_lines pl
          where pl.reservation_id = r.id
        )
      order by r.start_at desc
      limit 100
    `.catch(() => [] as UnpostedRow[]),

    sql<PayoutQueryRow[]>`
      select p.id,
             to_char(p.period_start, 'YYYY-MM-DD') as period_start,
             to_char(p.period_end, 'YYYY-MM-DD') as period_end,
             p.gross, p.deductions, p.net,
             p.status::text as status,
             coalesce(er.published->>'name', t.slug) as therapist_name,
             t.id as therapist_id
      from payouts p
      join therapists t on t.id = p.therapist_id
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      order by p.period_start desc
      limit 50
    `.catch(() => [] as PayoutQueryRow[]),
  ]);

  return {
    therapists: therapistRows as TherapistOption[],
    grid: ratesResult.ok ? (ratesResult.data ?? null) : null,
    ratesError: ratesResult.ok ? null : (ratesResult.error ?? null),
    unposted: unpostedRows.map((r) => ({
      id: r.id,
      startLabel: r.start_label,
      therapistName: r.therapist_name,
      therapistId: r.therapist_id,
      therapistSlug: r.therapist_slug,
      courseName: r.course_name,
      totalAmount: r.total_amount,
      nominationFee: r.nomination_fee,
      transportFee: r.transport_fee,
      status: r.status,
    })),
    payouts: payoutsRows.map((p) => ({
      id: p.id,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      gross: p.gross,
      deductions: p.deductions,
      net: p.net,
      status: p.status,
      therapistName: p.therapist_name,
      therapistId: p.therapist_id,
    })),
  };
}

export default async function PayoutsPage() {
  const data = await loadPageData();

  if ('error' in data) {
    return (
      <div className="bg-red-50 border border-adm-danger text-adm-danger rounded p-4 text-sm">
        {data.error}
      </div>
    );
  }

  if (!data.grid) {
    return (
      <div className="space-y-8">
        <h1 className="text-xl font-semibold text-adm-text">報酬管理</h1>
        <div className="bg-red-50 border border-adm-danger text-adm-danger rounded p-4 text-sm">
          {data.ratesError ?? 'レートの取得に失敗しました'}
        </div>
        <PayoutsClient
          grid={{ ranks: [], therapists: [], rates: [] }}
          therapists={data.therapists}
          initialUnposted={data.unposted}
          initialPayouts={data.payouts}
          unpostedError={null}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-adm-text">報酬管理</h1>
      <PayoutsClient
        grid={data.grid}
        therapists={data.therapists}
        initialUnposted={data.unposted}
        initialPayouts={data.payouts}
        unpostedError={null}
      />
    </div>
  );
}
