import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { searchCustomers } from '@/lib/customers/actions';
import { CustomersClient } from './CustomersClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '顧客管理' };

export default async function CustomersPage() {
  const session = await getDevSession();
  if (!session) redirect('/login');

  if (!can(toActor(session), 'manage_reservations')) {
    redirect('/admin');
  }

  // 初期表示は最近更新された顧客（空クエリ）
  const result = await searchCustomers('');

  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-1">顧客管理</h1>
      <p className="text-sm text-adm-muted mb-6">
        電話番号または名前で検索し、顧客情報・予約履歴・ポイント・指名NG・引き継ぎメモを確認・編集できます。
      </p>
      <CustomersClient
        initialCustomers={result.ok ? (result.data ?? []) : []}
        loadError={result.ok ? undefined : result.error}
      />
    </div>
  );
}
