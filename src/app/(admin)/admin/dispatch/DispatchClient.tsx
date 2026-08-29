'use client';

import { useState, useTransition } from 'react';
import {
  generateDispatchText,
  recordDispatch,
  listDispatchTargets,
} from '@/lib/dispatch/actions';
import type { DispatchTargetRow } from '@/lib/dispatch/actions';

interface Props {
  initialTargets: DispatchTargetRow[];
}

interface GeneratedText {
  reservationId: string;
  kind: 'inquiry' | 'confirmed';
  text: string;
}

/**
 * 配車テキスト生成クライアントコンポーネント（spec 8-3 ★）。
 *
 * - 「打診をコピー」: 常時有効（confirmed 状態の予約すべて）
 * - 「確定をコピー」: phone_confirmed=false の行は無効化 + ツールチップ
 * - コピー成功後に recordDispatch を呼び、送信済みバッジを更新
 * - コピー API 不可環境のフォールバック: モーダルにテキスト展開
 */
export default function DispatchClient({ initialTargets }: Props) {
  const [targets, setTargets] = useState<DispatchTargetRow[]>(initialTargets);
  const [generated, setGenerated] = useState<GeneratedText | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  const refreshTargets = async () => {
    const refreshed = await listDispatchTargets();
    if (refreshed.ok && refreshed.data) {
      setTargets(refreshed.data);
    }
  };

  const handleCopy = (reservationId: string, kind: 'inquiry' | 'confirmed') => {
    setErrorMsg(null);

    startTransition(async () => {
      // テキスト生成
      const genResult = await generateDispatchText(reservationId, kind);
      if (!genResult.ok || !genResult.data) {
        setErrorMsg(genResult.error ?? 'テキストの生成に失敗しました');
        return;
      }

      const { text } = genResult.data;

      // クリップボードへコピー
      let clipboardOk = false;
      try {
        await navigator.clipboard.writeText(text);
        clipboardOk = true;
      } catch {
        // clipboard API 不可: モーダルにフォールバック
      }

      // recordDispatch（コピー成功・失敗どちらでも記録。監査ログの対象）
      const recordResult = await recordDispatch(reservationId, kind, text);
      if (!recordResult.ok) {
        setErrorMsg(recordResult.error ?? 'ログの記録に失敗しました');
      }

      // 一覧を更新（送信済みバッジを反映）
      await refreshTargets();

      if (clipboardOk) {
        showToast(`${kind === 'inquiry' ? '打診' : '確定'}テキストをコピーしました`);
        setGenerated(null);
      } else {
        // フォールバック: モーダルに表示
        setGenerated({ reservationId, kind, text });
      }
    });
  };

  const formatStartAt = (iso: string) => {
    return new Date(iso).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div>
      {/* トースト */}
      {toastMsg && (
        <div
          className="fixed top-4 right-4 z-50 bg-adm-primary text-white px-4 py-2 rounded text-sm shadow-sm"
          style={{ borderRadius: '4px' }}
        >
          {toastMsg}
        </div>
      )}

      {errorMsg && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm mb-4">
          {errorMsg}
          <button
            onClick={() => setErrorMsg(null)}
            className="ml-2 text-red-600 underline text-xs"
          >
            閉じる
          </button>
        </div>
      )}

      {/* 空状態 */}
      {targets.length === 0 ? (
        <div className="text-sm text-adm-muted py-12 text-center bg-adm-surface border border-adm-border rounded">
          対象の予約はありません
          <br />
          <span className="text-xs">確定済み（status=confirmed）の予約が表示されます</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-adm-border bg-adm-bg">
                <th className="text-left px-3 py-2 font-medium text-adm-text">施術開始</th>
                <th className="text-left px-3 py-2 font-medium text-adm-text">顧客名</th>
                <th className="text-left px-3 py-2 font-medium text-adm-text">担当</th>
                <th className="text-left px-3 py-2 font-medium text-adm-text">電話確認</th>
                <th className="text-left px-3 py-2 font-medium text-adm-text">送信済み</th>
                <th className="px-3 py-2 text-center font-medium text-adm-text" colSpan={2}>
                  テキスト送信
                </th>
              </tr>
            </thead>
            <tbody>
              {targets.map((row) => (
                <tr key={row.reservationId} className="border-b border-adm-border hover:bg-adm-bg/50">
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatStartAt(row.startAtISO)}
                  </td>
                  <td className="px-3 py-2">{row.customerName}</td>
                  <td className="px-3 py-2">{row.therapistName}</td>
                  <td className="px-3 py-2">
                    {row.phoneConfirmed ? (
                      <span className="inline-block px-2 py-0.5 text-xs rounded bg-green-100 text-green-800 border border-green-200">
                        確認済み
                      </span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 text-xs rounded bg-yellow-100 text-yellow-800 border border-yellow-200">
                        未確認
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-0.5">
                      {row.inquirySent && (
                        <span className="inline-block px-2 py-0.5 text-xs rounded bg-adm-bg border border-adm-border text-adm-text">
                          打診済
                        </span>
                      )}
                      {row.confirmedSent && (
                        <span className="inline-block px-2 py-0.5 text-xs rounded bg-adm-primary/10 border border-adm-primary/30 text-adm-primary">
                          確定済
                        </span>
                      )}
                      {!row.inquirySent && !row.confirmedSent && (
                        <span className="text-xs text-adm-muted">未送信</span>
                      )}
                    </div>
                  </td>

                  {/* 打診をコピー */}
                  <td className="px-3 py-2">
                    <button
                      onClick={() => handleCopy(row.reservationId, 'inquiry')}
                      disabled={isPending}
                      className="px-3 py-1.5 text-xs border border-adm-border text-adm-text rounded hover:bg-adm-bg disabled:opacity-50 transition-colors whitespace-nowrap"
                      style={{ borderRadius: '4px' }}
                    >
                      打診をコピー
                    </button>
                  </td>

                  {/* 確定をコピー */}
                  <td className="px-3 py-2">
                    {row.phoneConfirmed ? (
                      <button
                        onClick={() => handleCopy(row.reservationId, 'confirmed')}
                        disabled={isPending}
                        className="px-3 py-1.5 text-xs bg-adm-primary text-white rounded hover:opacity-90 disabled:opacity-50 transition-opacity whitespace-nowrap"
                        style={{ borderRadius: '4px' }}
                      >
                        確定をコピー
                      </button>
                    ) : (
                      <span title="電話確認が未完了のため確定用テキストは生成できません">
                        <button
                          disabled
                          className="px-3 py-1.5 text-xs bg-adm-primary text-white rounded opacity-30 cursor-not-allowed whitespace-nowrap"
                          style={{ borderRadius: '4px' }}
                          aria-label="電話確認が未完了"
                        >
                          確定をコピー
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* フォールバックモーダル（クリップボード API 不可環境用） */}
      {generated && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-adm-surface border border-adm-border rounded p-6 w-full max-w-lg mx-4">
            <h2 className="text-base font-semibold text-adm-text mb-1">
              {generated.kind === 'inquiry' ? '打診用テキスト' : '確定用テキスト'}
            </h2>
            <p className="text-xs text-adm-muted mb-3">
              自動コピーできませんでした。以下のテキストを手動でコピーしてください。
            </p>
            <pre className="bg-adm-bg border border-adm-border rounded p-3 text-sm whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">
              {generated.text}
            </pre>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(generated.text).catch(() => undefined);
                  showToast('コピーしました');
                  setGenerated(null);
                }}
                className="flex-1 bg-adm-primary text-white rounded px-3 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
                style={{ borderRadius: '4px' }}
              >
                コピー
              </button>
              <button
                onClick={() => setGenerated(null)}
                className="px-3 py-2 border border-adm-border rounded text-sm text-adm-text hover:bg-adm-bg"
                style={{ borderRadius: '4px' }}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
