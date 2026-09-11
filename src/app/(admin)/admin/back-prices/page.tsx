/**
 * バック単価表ページ（コース/オプション/指名のデフォルト固定バック単価）。
 * payout_rates の fixed 行を再利用して表示・編集する。
 * 保存は既存の upsertPayoutRate（owner/admin のみ）を使う。
 * force-dynamic: DB 読取のため毎リクエスト実行。
 */

import type { Metadata } from 'next';
import { getDevSession } from '@/lib/cms/dev-session';
import { listBackPriceTargets } from '@/lib/payout/back-prices-actions';
import BackPricesClient from './BackPricesClient';

export const metadata: Metadata = { title: 'バック単価表' };
export const dynamic = 'force-dynamic';

export default async function BackPricesPage() {
  const session = await getDevSession();
  if (!session) {
    return (
      <div className="p-6 text-sm text-adm-muted">
        認証が必要です
      </div>
    );
  }

  const canWrite = session.role === 'owner' || session.role === 'admin';

  const result = await listBackPriceTargets();
  if (!result.ok || !result.data) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-bold text-adm-text mb-4">バック単価表</h1>
        <p className="text-sm text-adm-danger">{result.error ?? 'データの取得に失敗しました'}</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-lg font-bold text-adm-text mb-1">バック単価表</h1>
      <p className="text-xs text-adm-muted mb-6">
        コース・オプション・指名のデフォルト固定バック単価（payout_rates の fixed 行）を表示・編集します。
        個別セラピスト設定は「報酬」ページで行ってください。
      </p>
      <BackPricesClient
        courses={result.data.courses}
        options={result.data.options}
        nominationBackYen={result.data.nominationBackYen}
        canWrite={canWrite}
      />
    </div>
  );
}
