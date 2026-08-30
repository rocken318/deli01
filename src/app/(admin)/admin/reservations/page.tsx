/**
 * 予約管理（フェーズ15 / spec 3-4・6章）。
 * 直近の予約に対して当日オプション追加（延長）・キャンセルを行う。
 * 管理側なので日本語直書き可。spec 12-2 準拠。
 */

import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { ReservationsClient, type ReservationRow, type OptionChoice } from './ReservationsClient';

export const dynamic = 'force-dynamic';

export default async function ReservationsPage() {
  const session = await getDevSession();
  if (!session) {
    return <p className="text-adm-muted">認証が必要です。</p>;
  }

  const sql = getClient();
  const rows = await withUser(sql, session, async (tx) => {
    return tx<{
      id: string;
      customer_name: string | null;
      therapist_name: string | null;
      therapist_slug: string;
      course_name: string;
      start_at: Date;
      status: string;
      total_amount: number;
      options: string | null;
    }[]>`
      select r.id,
             c.name as customer_name,
             er.published->>'name' as therapist_name,
             t.slug as therapist_slug,
             co.name as course_name,
             r.start_at,
             r.status::text,
             r.total_amount,
             (select string_agg(o.name, '、')
                from reservation_options ro join options o on o.id = ro.option_id
               where ro.reservation_id = r.id) as options
      from reservations r
      join therapists t on t.id = r.therapist_id
      left join customers c on c.id = r.customer_id
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      join courses co on co.id = r.course_id
      where r.status in ('confirmed', 'enroute', 'in_service')
        and r.start_at >= now() - interval '2 hours'
      order by r.start_at asc
      limit 50
    `;
  });

  const optionRows = await sql<{ id: string; name: string; duration_min: number; price: number }[]>`
    select id, name, duration_min, price from options
    where is_active and is_public and duration_min > 0
    order by sort_order asc
  `;

  const reservations: ReservationRow[] = rows.map((r) => ({
    id: r.id,
    customerName: r.customer_name ?? '（未設定）',
    therapistName: r.therapist_name ?? r.therapist_slug,
    courseName: r.course_name,
    startAtISO: r.start_at.toISOString(),
    status: r.status,
    totalAmount: r.total_amount,
    options: r.options,
  }));

  const options: OptionChoice[] = optionRows.map((o) => ({
    id: o.id,
    name: o.name,
    durationMin: o.duration_min,
    price: o.price,
  }));

  return (
    <div>
      <h1 className="text-lg font-semibold mb-4">予約管理</h1>
      <p className="text-sm text-adm-muted mb-4">
        当日オプション追加は後続予約に間に合う場合のみ登録できます（間に合わない場合は拒否されます）。
      </p>
      <ReservationsClient reservations={reservations} options={options} />
    </div>
  );
}
