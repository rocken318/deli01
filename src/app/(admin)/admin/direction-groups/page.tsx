import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { listDirectionGroups } from '@/lib/dispatch-board/direction-actions';
import { DirectionGroupsClient } from './DirectionGroupsClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '方面グループ' };

export default async function DirectionGroupsPage() {
  const session = await getDevSession();
  if (!session) redirect('/login');
  const result = await listDirectionGroups();
  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-1">方面グループ</h1>
      <p className="text-sm text-adm-muted mb-6">
        配車ボードで使う方面グループ（泉区・松森方面 等）を登録します。
      </p>
      <DirectionGroupsClient
        initialGroups={result.ok ? (result.data ?? []) : []}
        loadError={result.ok ? undefined : result.error}
        canWrite={can(toActor(session), 'manage_cms')}
      />
    </div>
  );
}
