import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { listDrivers } from '@/lib/drivers/actions';
import { DriversClient } from './DriversClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ドライバー登録' };

export default async function DriversPage() {
  const session = await getDevSession();
  if (!session) redirect('/login');
  const result = await listDrivers();
  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-1">ドライバー登録</h1>
      <p className="text-sm text-adm-muted mb-6">
        ドライバー・車両・識別色を登録します。ここで決めた色が配車ボードで使われます。
      </p>
      <DriversClient
        initialDrivers={result.ok ? (result.data ?? []) : []}
        loadError={result.ok ? undefined : result.error}
        canWrite={can(toActor(session), 'manage_cms')}
      />
    </div>
  );
}
