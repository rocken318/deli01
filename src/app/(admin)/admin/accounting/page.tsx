/**
 * 会計サマリーページ（フェーズ17 / spec 10章 L853-869・11-6）。
 * 完了条件「前受金・ポイント引当・売上・経費が分けて出る」の可視化。
 * 管理側なので日本語直書き可。spec 12-2 デザイントークン準拠。
 * force-dynamic: DB 読取のため毎リクエスト実行。
 */

import type { Metadata } from 'next';
import { getDevSession } from '@/lib/cms/dev-session';
import { getClient } from '@/lib/db-client';
import { listUnpostedDoneReservations } from '@/lib/accounting/actions';
import { AccountingClient } from './AccountingClient';

export const metadata: Metadata = { title: '会計' };
export const dynamic = 'force-dynamic';

interface AreaOption {
  id: string;
  name: string;
}

interface TherapistOption {
  id: string;
  name: string;
}

async function loadPageData() {
  const session = await getDevSession();
  if (!session) return { error: '認証が必要です' };

  const sql = getClient();

  const [areaRows, therapistRows, unpostedResult] = await Promise.all([
    sql<{ id: string; name: string }[]>`
      select id, name from areas order by name asc
    `.catch(() => [] as { id: string; name: string }[]),

    sql<{ id: string; name: string }[]>`
      select t.id, coalesce(er.published->>'name', t.slug) as name
      from therapists t
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      where t.status = 'active'
      order by t.display_order asc
    `.catch(() => [] as { id: string; name: string }[]),

    listUnpostedDoneReservations(),
  ]);

  return {
    areas: areaRows as AreaOption[],
    therapists: therapistRows as TherapistOption[],
    unpostedReservations: unpostedResult.ok ? (unpostedResult.data ?? []) : [],
    unpostedError: unpostedResult.ok ? null : (unpostedResult.error ?? null),
  };
}

export default async function AccountingPage() {
  const data = await loadPageData();

  if ('error' in data) {
    return (
      <div className="bg-red-50 border border-adm-danger text-adm-danger rounded p-4 text-sm">
        {data.error}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-adm-text">会計</h1>
      <AccountingClient
        areas={data.areas}
        therapists={data.therapists}
        initialUnpostedReservations={data.unpostedReservations}
        unpostedError={data.unpostedError}
      />
    </div>
  );
}
