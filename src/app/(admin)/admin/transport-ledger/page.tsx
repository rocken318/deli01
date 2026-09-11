import type { Metadata } from 'next';
import { listTransportLedger, listTherapistsForLedger } from '@/lib/transport/actions';
import TransportLedgerClient from './TransportLedgerClient';

export const metadata: Metadata = {
  title: '送り台帳',
};

export const dynamic = 'force-dynamic';

export default async function TransportLedgerPage() {
  const [ledgerResult, therapistsResult] = await Promise.all([
    listTransportLedger(),
    listTherapistsForLedger(),
  ]);
  const rows = ledgerResult.ok ? (ledgerResult.data ?? []) : [];
  const therapists = therapistsResult.ok ? (therapistsResult.data ?? []) : [];
  const error = ledgerResult.ok ? undefined : ledgerResult.error;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-adm-text">送り台帳</h1>
      </div>
      <p className="text-sm text-adm-muted mb-6">
        女性ごとの送り先（自宅・寮・宿泊先）と往復時間を登録します。退勤送りの自動補完に使われます。
      </p>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm mb-4">
          {error}
        </div>
      )}
      <TransportLedgerClient initialRows={rows} therapists={therapists} />
    </div>
  );
}
