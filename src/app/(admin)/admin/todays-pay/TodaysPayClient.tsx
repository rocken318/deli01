'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { TodaysPayRow } from '@/lib/payout/todays-pay-actions';
import { settleTodaysPay, unsettleTodaysPay } from '@/lib/payout/todays-pay-actions';

interface Props {
  initialRows: TodaysPayRow[];
  dateISO: string;
  todayISO: string;
}

function fmt(n: number): string {
  return '¥' + n.toLocaleString('ja-JP');
}

function prevDate(dateISO: string): string {
  const d = new Date(dateISO + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextDate(dateISO: string): string {
  const d = new Date(dateISO + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function jpDateLabel(dateISO: string): string {
  const d = new Date(dateISO + 'T00:00:00');
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()] ?? '';
  return `${m}/${day}（${dow}）`;
}

export default function TodaysPayClient({ initialRows, dateISO, todayISO }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<TodaysPayRow[]>(initialRows);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialRows[0]?.therapistId ?? null,
  );
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const selected = rows.find((r) => r.therapistId === selectedId) ?? null;

  const totalPay = rows.reduce((s, r) => s + r.pay, 0);
  const unsettledPay = rows.filter((r) => !r.settled).reduce((s, r) => s + r.pay, 0);
  const unsettledCount = rows.filter((r) => !r.settled).length;

  function goDate(iso: string) {
    router.push(`/admin/todays-pay?date=${iso}`);
  }

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  function handleSettle() {
    if (!selected) return;
    const therapistId = selected.therapistId;
    startTransition(async () => {
      const result = await settleTodaysPay({ therapistId, dateISO });
      if (!result.ok) {
        showToast(result.error ?? '精算に失敗しました', false);
        return;
      }
      if (result.data?.already) {
        showToast('既に精算済みです', false);
        return;
      }
      // Update rows in state to mark as settled
      setRows((prev) =>
        prev.map((r) =>
          r.therapistId === therapistId
            ? { ...r, settled: true, paidAt: new Date().toISOString().slice(0, 16).replace('T', ' ') }
            : r,
        ),
      );
      showToast('精算を記録しました', true);
    });
  }

  function handleUnsettle() {
    if (!selected) return;
    const therapistId = selected.therapistId;
    startTransition(async () => {
      const result = await unsettleTodaysPay({ therapistId, dateISO });
      if (!result.ok) {
        showToast(result.error ?? '精算取消に失敗しました', false);
        return;
      }
      // Update rows in state to mark as unsettled
      setRows((prev) =>
        prev.map((r) =>
          r.therapistId === therapistId
            ? { ...r, settled: false, paidAt: null }
            : r,
        ),
      );
      showToast('精算を取消しました', true);
    });
  }

  // 3 states: loading / error / empty
  if (rows === null) {
    return (
      <div className="text-sm text-adm-muted">読み込み中…</div>
    );
  }

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 px-4 py-2 rounded text-sm font-semibold text-white ${toast.ok ? 'bg-adm-primary' : 'bg-adm-danger'}`}
          style={{ borderRadius: '6px' }}
        >
          {toast.msg}
        </div>
      )}

      {/* 日付ナビ */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => goDate(prevDate(dateISO))}
          className="px-2 py-1 text-sm border border-adm-border rounded text-adm-text hover:bg-adm-bg"
          style={{ borderRadius: '4px' }}
        >
          ◀
        </button>
        <span className="text-sm font-semibold text-adm-text">
          {jpDateLabel(dateISO)}
          {dateISO === todayISO && (
            <span className="ml-2 text-xs font-bold text-white bg-adm-primary px-2 py-0.5 rounded" style={{ borderRadius: '4px' }}>
              本日
            </span>
          )}
        </span>
        <button
          onClick={() => goDate(nextDate(dateISO))}
          className="px-2 py-1 text-sm border border-adm-border rounded text-adm-text hover:bg-adm-bg"
          style={{ borderRadius: '4px' }}
          disabled={dateISO >= todayISO}
        >
          ▶
        </button>
      </div>

      <div className="flex gap-4 items-start">
        {/* 左: 女性リスト */}
        <div
          className="w-52 flex-shrink-0 bg-adm-surface border border-adm-border p-2"
          style={{ borderRadius: '8px' }}
        >
          <div className="text-xs font-bold text-adm-muted uppercase mb-2 px-1">本日の女性</div>

          {rows.length === 0 ? (
            <p className="text-xs text-adm-muted py-4 text-center">本日の支払なし</p>
          ) : (
            rows.map((row) => (
              <button
                key={row.therapistId}
                onClick={() => setSelectedId(row.therapistId)}
                className={`w-full text-left flex items-center gap-2 px-2 py-2 mb-1 ${
                  row.therapistId === selectedId
                    ? 'bg-[#EAF3EF] border-l-2 border-adm-primary'
                    : 'border-l-2 border-transparent hover:bg-adm-bg'
                }`}
                style={{ borderRadius: '6px' }}
              >
                <span className="font-bold text-sm text-adm-text truncate flex-1">
                  {row.therapistName}
                </span>
                <span className="font-mono text-sm font-bold text-adm-text whitespace-nowrap">
                  {fmt(row.pay)}
                </span>
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                    row.settled
                      ? 'bg-[#E7F3EC] text-[#1f7a54]'
                      : 'bg-[#FBF3E6] text-[#8a5d16]'
                  }`}
                >
                  {row.settled ? '済' : '未'}
                </span>
              </button>
            ))
          )}

          {/* サマリ */}
          {rows.length > 0 && (
            <div
              className="mt-2 pt-2 border-t border-dashed border-adm-border text-xs text-adm-muted px-1"
            >
              <div className="flex justify-between mb-0.5">
                <span>本日支払合計</span>
                <span className="font-mono font-bold text-adm-text">{fmt(totalPay)}</span>
              </div>
              {unsettledCount > 0 && (
                <div className="flex justify-between">
                  <span>未精算 {unsettledCount}名</span>
                  <span className="font-mono font-bold text-[#8a5d16]">{fmt(unsettledPay)}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 右: 精算パネル */}
        {selected ? (
          <div
            className="flex-1 min-w-0 bg-adm-surface border border-adm-border p-5"
            style={{ borderRadius: '8px' }}
          >
            <h2 className="text-base font-bold text-adm-text mb-1">
              {selected.therapistName} の当日精算
            </h2>
            <p className="text-xs text-adm-muted mb-4">
              成約（完了）分を自動集計したバックから雑費（合計の10%）を引いた支払額です。
            </p>

            {/* カテゴリ内訳テーブル */}
            <table className="w-full border-collapse mb-4 text-sm">
              <thead>
                <tr className="border-b-2 border-adm-border">
                  <th className="text-left py-1.5 px-2 text-xs text-adm-muted font-bold bg-adm-bg">区分</th>
                  <th className="text-right py-1.5 px-2 text-xs text-adm-muted font-bold bg-adm-bg">金額</th>
                </tr>
              </thead>
              <tbody>
                {selected.lines.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="py-4 text-center text-xs text-adm-muted">
                      バック明細なし
                    </td>
                  </tr>
                ) : (
                  selected.lines.map((line, i) => (
                    <tr key={i} className="border-b border-adm-border">
                      <td className="py-1.5 px-2 text-adm-text">{line.category}</td>
                      <td className="py-1.5 px-2 text-right font-mono font-bold text-adm-text">
                        {fmt(line.amount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {/* 合計・雑費・支払額 */}
            <div className="border border-adm-border mb-4" style={{ borderRadius: '8px', overflow: 'hidden' }}>
              <div className="flex justify-between items-center px-3 py-2 border-b border-adm-border">
                <span className="text-sm text-adm-muted">合計（バック小計の総和）</span>
                <span className="font-mono font-bold text-adm-text">{fmt(selected.gross)}</span>
              </div>
              <div className="flex justify-between items-center px-3 py-2 border-b border-adm-border text-[#8a5d16]">
                <span className="text-sm">雑費（合計の10%）</span>
                <span className="font-mono font-bold">− {fmt(selected.misc)}</span>
              </div>
              <div className="flex justify-between items-center px-3 py-2.5 bg-[#EAF3EF]">
                <span className="text-sm font-extrabold text-[#173a30]">支払額（当日給料）</span>
                <span className="font-mono text-xl font-extrabold text-[#173a30]">{fmt(selected.pay)}</span>
              </div>
            </div>

            {/* 精算ボタン or 精算済み表示 */}
            {selected.settled ? (
              <div
                className="flex items-center gap-3 bg-[#EAF3EF] border border-adm-primary px-4 py-3"
                style={{ borderRadius: '8px' }}
              >
                <span className="flex-1 text-sm font-bold text-[#173a30]">
                  精算済み
                  {selected.paidAt && (
                    <span className="ml-2 font-normal text-[#6B7776]">（{selected.paidAt}）</span>
                  )}
                </span>
                <button
                  onClick={handleUnsettle}
                  disabled={isPending}
                  className="px-3 py-1.5 border border-adm-border bg-adm-surface text-adm-text text-xs rounded hover:bg-adm-bg disabled:opacity-50"
                  style={{ borderRadius: '6px' }}
                >
                  {isPending ? '処理中…' : '精算取消'}
                </button>
              </div>
            ) : (
              <div
                className="flex items-center gap-3 bg-[#F6FBF9] border border-adm-primary px-4 py-3"
                style={{ borderRadius: '10px' }}
              >
                <div className="flex-1">
                  <span className="text-sm text-[#245043]">
                    手渡し現金{' '}
                    <span className="text-[22px] font-mono font-bold">{fmt(selected.pay)}</span>
                  </span>
                </div>
                <button
                  onClick={handleSettle}
                  disabled={isPending}
                  className="px-4 py-2 bg-adm-primary text-white text-sm font-bold border border-adm-primary hover:opacity-90 disabled:opacity-50"
                  style={{ borderRadius: '8px' }}
                >
                  {isPending ? '記録中…' : 'この場で精算（支払済みにする）'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div
            className="flex-1 min-w-0 bg-adm-surface border border-adm-border p-8 text-center"
            style={{ borderRadius: '8px' }}
          >
            {rows.length === 0 ? (
              <p className="text-sm text-adm-muted">本日のバック計上はありません</p>
            ) : (
              <p className="text-sm text-adm-muted">左から女性を選択してください</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
