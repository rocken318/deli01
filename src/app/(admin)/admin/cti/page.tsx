/**
 * CTI 着信ポップ（フェーズ14・ポーリング＋ポップ＋模擬着信 / spec 22章）。
 * 初期データをサーバで取得してクライアントコンポーネントに渡す。
 * クライアント側は 4.5秒ごとにポーリングし、新着着信をリアルタイムで更新する。
 */

import { getRecentIncomingCalls } from '@/lib/cti/actions';
import CtiConsoleClient from './CtiConsoleClient';

export const dynamic = 'force-dynamic';

export default async function CtiPage() {
  const result = await getRecentIncomingCalls(300);
  const initialEvents = result.ok ? (result.data ?? []) : [];

  return (
    <div>
      <h1 className="text-lg font-semibold mb-1">着信受付コンソール</h1>
      <p className="text-sm text-adm-muted mb-4">
        着信を顧客と紐付け、ワンクリックで予約入力画面を開けます。
        実回線は <code className="text-xs bg-adm-bg px-1 rounded">/api/cti/incoming</code> に webhook を設定してください。
      </p>
      {result.ok ? (
        <CtiConsoleClient initialEvents={initialEvents} />
      ) : (
        <p className="text-adm-alert text-sm">着信データの取得に失敗しました: {result.error}</p>
      )}
    </div>
  );
}
