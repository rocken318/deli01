import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { listOptionsAdmin } from '@/lib/options/actions';
import { OptionsClient } from './OptionsClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'オプション管理' };

export default async function OptionsPage() {
  const session = await getDevSession();
  if (!session) redirect('/login');
  const result = await listOptionsAdmin();
  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-1">オプション管理</h1>
      <p className="text-sm text-adm-muted mb-6">
        コースに追加できるオプションを登録・編集します。
      </p>
      <OptionsClient
        initialOptions={result.ok ? (result.data ?? []) : []}
        loadError={result.ok ? undefined : result.error}
        canWrite={can(toActor(session), 'manage_cms')}
      />
    </div>
  );
}
