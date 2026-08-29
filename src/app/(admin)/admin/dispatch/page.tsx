import type { Metadata } from 'next';
import { listDispatchTargets } from '@/lib/dispatch/actions';
import DispatchClient from './DispatchClient';

export const metadata: Metadata = {
  title: '配車テキスト',
};

export const dynamic = 'force-dynamic';

/**
 * 配車テキスト生成ページ（Server Component）。
 * confirmed 状態の予約一覧を表示し、打診・確定用テキストをコピーできる。
 *
 * フェーズ14 配車ボードとの責務分界:
 * - このページは「送信テキストのコピー」が主目的。一覧は予約の電話順。
 * - 配車ボード（phase14）は時系列のガントチャート。移動→施術→移動の3ブロック。
 *   actions.ts を import して同じアクションを再利用する。
 */
export default async function DispatchPage() {
  const result = await listDispatchTargets();
  const targets = result.ok ? (result.data ?? []) : [];
  const error = result.ok ? undefined : result.error;

  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-1">配車テキスト</h1>
      <p className="text-sm text-adm-muted mb-6">
        確定済み予約に対して打診用・確定用のテキストを生成し、LINE 等に貼って送ります。
        確定用（住所入り）は電話確認済みの予約のみ有効です。
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm mb-4">
          {error}
        </div>
      )}

      <DispatchClient initialTargets={targets} />
    </div>
  );
}
