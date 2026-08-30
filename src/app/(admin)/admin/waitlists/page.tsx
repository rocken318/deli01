/**
 * キャンセル待ち管理（フェーズ15 / spec 5 L656-660）。
 * 希望条件の一覧と、受付からの手動登録。通知はフェーズ20。
 * 管理側なので日本語直書き可。spec 12-2 準拠。
 */

import { getClient } from '@/lib/db-client';
import { listWaitlists } from '@/lib/booking/waitlist-actions';
import { WaitlistClient, type CourseChoice, type TherapistChoice, type AreaChoice } from './WaitlistClient';

export const dynamic = 'force-dynamic';

export default async function WaitlistsPage() {
  const listed = await listWaitlists();
  if (!listed.ok) {
    return <p className="text-adm-muted">{listed.error}</p>;
  }

  const sql = getClient();
  const [areas, therapists, courses] = await Promise.all([
    sql<{ id: string; name: string }[]>`select id, name from areas order by sort_order asc`,
    sql<{ id: string; name: string }[]>`
      select t.id, coalesce(er.published->>'name', t.slug) as name
      from therapists t
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      where t.status = 'active' order by t.display_order asc
    `,
    sql<{ id: string; name: string }[]>`select id, name from courses where is_active order by sort_order asc`,
  ]);

  return (
    <div>
      <h1 className="text-lg font-semibold mb-4">キャンセル待ち</h1>
      <p className="text-sm text-adm-muted mb-4">
        希望条件を登録します。空きが出たときの通知はメール整備後（フェーズ20）。先着の仮押さえ権は付きません。
      </p>
      <WaitlistClient
        rows={listed.data ?? []}
        areas={areas as AreaChoice[]}
        therapists={therapists as TherapistChoice[]}
        courses={courses as CourseChoice[]}
      />
    </div>
  );
}
