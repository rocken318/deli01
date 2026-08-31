'use client';

/**
 * 集計クライアントコンポーネント（フェーズ19 / spec 10章 L860-869・11-6）。
 *
 * - 期間・エリアフィルタ
 * - Section A: エリア別粗利テーブル（突合）
 * - Section B: 需要ヒートマップ（曜日×エリア）
 * - Section C: CSV ダウンロード（突合・売上明細・報酬明細）
 * - 各セクション: 空状態・ローディング・エラーの3状態
 *
 * spec 12-2 デザイントークン準拠。角丸4pxまで。影なし罫線区切り。
 */

import { useState, useTransition, useCallback } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import { getReconciliation, getDemandHeatmap, getTherapistBreakdown } from '@/lib/analytics/actions';
import type {
  ReconciliationResult,
  HeatmapResult,
  AreaReconciliation,
  TherapistBreakdownResult,
} from '@/lib/analytics/actions';

interface AreaOption { id: string; name: string }
interface Props { areas: AreaOption[] }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function thisMonthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const fromDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const toDate = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
  return { fromDate, toDate };
}

function toISO(dateStr: string, startOfDay = true): string {
  return `${dateStr}T${startOfDay ? '00:00:00' : '23:59:59'}+09:00`;
}

function fmtMoney(n: number): string {
  return n.toLocaleString('ja-JP') + '円';
}

function todayJST(): string {
  return formatInTimeZone(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

const REASON_LABELS: Record<string, string> = {
  time: '時間帯',
  area: 'エリア外',
  nomination: '指名',
  price: '料金',
  other: 'その他',
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: '現金',
  card: 'カード',
  emoney: '電子マネー',
  ticket: '回数券',
  point: 'ポイント',
};

function heatmapCellStyle(lostCount: number): { backgroundColor: string; color: string } {
  if (lostCount === 0) return { backgroundColor: '#FFFFFF', color: '#1C2321' };
  if (lostCount <= 2) return { backgroundColor: '#FBF0DD', color: '#1C2321' };
  if (lostCount <= 5) return { backgroundColor: '#F5DEB3', color: '#1C2321' };
  return { backgroundColor: '#C98A2B', color: '#FFFFFF' };
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div
        className="w-8 h-8 border-2 border-adm-border rounded-full animate-spin"
        style={{ borderTopColor: '#3F7A6B' }}
        aria-label="読み込み中"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-sm text-adm-subtext border border-adm-border rounded bg-adm-bg" style={{ borderRadius: '4px' }}>
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorBanner
// ---------------------------------------------------------------------------

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="p-3 bg-red-50 border border-adm-danger text-adm-danger text-sm rounded" style={{ borderRadius: '4px' }}>
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section A: 突合テーブル
// ---------------------------------------------------------------------------

function ReconciliationTable({ data }: { data: ReconciliationResult }) {
  const rows: AreaReconciliation[] = [...data.byArea, data.total];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-adm-border bg-adm-bg">
            <th className="text-left px-3 py-2 font-medium text-adm-text">エリア</th>
            <th className="text-right px-3 py-2 font-medium text-adm-text">売上</th>
            <th className="text-right px-3 py-2 font-medium text-adm-text">バック</th>
            <th className="text-right px-3 py-2 font-medium text-adm-text">経費</th>
            <th className="text-right px-3 py-2 font-medium text-adm-text">粗利</th>
            <th className="text-right px-3 py-2 font-medium text-adm-text">件数</th>
            <th className="text-right px-3 py-2 font-medium text-adm-text">客単価</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const isTotal = idx === rows.length - 1;
            return (
              <tr
                key={row.areaId ?? `total-${idx}`}
                className={[
                  'border-b border-adm-border',
                  isTotal ? 'font-semibold bg-adm-bg' : 'bg-adm-surface hover:bg-adm-bg',
                ].join(' ')}
              >
                <td className="px-3 py-2 text-adm-text">
                  {isTotal ? '合計' : (row.areaName ?? '不明エリア')}
                </td>
                <td className="px-3 py-2 text-right text-adm-text tabular-nums">
                  {fmtMoney(row.revenue)}
                </td>
                <td className="px-3 py-2 text-right text-adm-text tabular-nums">
                  {fmtMoney(row.payout)}
                </td>
                <td className="px-3 py-2 text-right text-adm-text tabular-nums">
                  {fmtMoney(row.expenses)}
                </td>
                <td
                  className="px-3 py-2 text-right tabular-nums"
                  style={{ color: row.grossProfit < 0 ? '#B4453C' : '#1C2321' }}
                >
                  {fmtMoney(row.grossProfit)}
                </td>
                <td className="px-3 py-2 text-right text-adm-text tabular-nums">
                  {row.reservationCount}件
                </td>
                <td className="px-3 py-2 text-right text-adm-text tabular-nums">
                  {row.avgRevenue > 0 ? fmtMoney(row.avgRevenue) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 支払方法内訳 */}
      {Object.values(data.paymentsByMethod).some((v) => v > 0) && (
        <div className="mt-4 p-3 bg-adm-bg border border-adm-border rounded text-sm" style={{ borderRadius: '4px' }}>
          <p className="text-xs font-medium text-adm-text mb-2">支払方法内訳</p>
          <div className="flex flex-wrap gap-4">
            {Object.entries(data.paymentsByMethod).map(([method, amount]) =>
              amount > 0 ? (
                <span key={method} className="text-adm-text tabular-nums">
                  {PAYMENT_LABELS[method] ?? method}: {fmtMoney(amount)}
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}

      {/* ポイント引当・前受金 */}
      <div className="mt-2 p-3 bg-adm-bg border border-adm-border rounded text-sm" style={{ borderRadius: '4px' }}>
        <div className="flex gap-8">
          <span className="text-adm-text">
            ポイント引当残: <span className="tabular-nums">{fmtMoney(data.pointLiability)}</span>
          </span>
          <span className="text-adm-text">
            前受金（回数券残）: <span className="tabular-nums">{fmtMoney(data.deferredRevenue)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section B: 需要ヒートマップ
// ---------------------------------------------------------------------------

function DemandHeatmap({ data }: { data: HeatmapResult }) {
  // エリア軸を収集（ユニーク）
  const areaKeys = Array.from(
    new Map(
      data.cells.map((c) => [c.areaId ?? 'null', c.areaName ?? '不明エリア']),
    ).entries(),
  );

  if (data.cells.length === 0) {
    return <EmptyState message="該当するデータがありません" />;
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse">
          <thead>
            <tr className="border-b border-adm-border bg-adm-bg">
              <th className="px-3 py-2 text-left font-medium text-adm-text min-w-[3rem]">曜日</th>
              {areaKeys.map(([key, name]) => (
                <th key={key} className="px-3 py-2 text-center font-medium text-adm-text min-w-[7rem]">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DOW_LABELS.map((dowLabel, dow) => (
              <tr key={dow} className="border-b border-adm-border">
                <td className="px-3 py-2 font-medium text-adm-text bg-adm-bg">{dowLabel}</td>
                {areaKeys.map(([key, _name]) => {
                  const cell = data.cells.find(
                    (c) => c.dow === dow && (c.areaId ?? 'null') === key,
                  );
                  const lostCount = cell?.lostCount ?? 0;
                  const wonCount = cell?.wonCount ?? 0;
                  const style = heatmapCellStyle(lostCount);
                  return (
                    <td
                      key={key}
                      className="px-3 py-2 text-center"
                      style={{ backgroundColor: style.backgroundColor, color: style.color }}
                    >
                      {lostCount === 0 && wonCount === 0 ? (
                        <span className="text-adm-subtext">—</span>
                      ) : (
                        <span className="tabular-nums text-xs leading-tight block">
                          <span title="成約件数">成{wonCount}件</span>
                          {' / '}
                          <span title="取り逃し件数">逃{lostCount}件</span>
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 凡例 */}
      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-adm-text">
        <span className="font-medium">取り逃し件数:</span>
        {[
          { label: '0件', bg: '#FFFFFF', fg: '#1C2321' },
          { label: '1〜2件', bg: '#FBF0DD', fg: '#1C2321' },
          { label: '3〜5件', bg: '#F5DEB3', fg: '#1C2321' },
          { label: '6件以上', bg: '#C98A2B', fg: '#FFFFFF' },
        ].map(({ label, bg, fg }) => (
          <span
            key={label}
            className="px-2 py-0.5 border border-adm-border"
            style={{ backgroundColor: bg, color: fg, borderRadius: '2px' }}
          >
            {label}
          </span>
        ))}
      </div>

      {/* 取り逃し理由内訳 */}
      {Object.values(data.reasons).some((v) => v > 0) && (
        <div className="mt-4 p-3 bg-adm-bg border border-adm-border rounded text-sm" style={{ borderRadius: '4px' }}>
          <p className="text-xs font-medium text-adm-text mb-2">取り逃し理由内訳</p>
          <div className="flex flex-wrap gap-4">
            {Object.entries(data.reasons).map(([reason, count]) =>
              count > 0 ? (
                <span key={reason} className="text-adm-text tabular-nums">
                  {REASON_LABELS[reason] ?? reason}: {count}件
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section C: CSV ダウンロード
// ---------------------------------------------------------------------------

function CsvDownloadSection({
  fromDate,
  toDate,
}: {
  fromDate: string;
  toDate: string;
}) {
  function downloadCsv(type: 'reconciliation' | 'revenue' | 'payout') {
    const fromISO = toISO(fromDate, true);
    const toISO_ = toISO(toDate, true);
    const url = `/admin/analytics/export?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO_)}&type=${type}`;
    window.open(url, '_blank');
  }

  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="button"
        onClick={() => downloadCsv('reconciliation')}
        className="px-4 py-2 text-sm border border-adm-border bg-adm-surface text-adm-text hover:bg-adm-bg transition-colors"
        style={{ borderRadius: '4px' }}
      >
        突合 CSV
      </button>
      <button
        type="button"
        onClick={() => downloadCsv('revenue')}
        className="px-4 py-2 text-sm border border-adm-border bg-adm-surface text-adm-text hover:bg-adm-bg transition-colors"
        style={{ borderRadius: '4px' }}
      >
        売上明細 CSV
      </button>
      <button
        type="button"
        onClick={() => downloadCsv('payout')}
        className="px-4 py-2 text-sm border border-adm-border bg-adm-surface text-adm-text hover:bg-adm-bg transition-colors"
        style={{ borderRadius: '4px' }}
      >
        報酬明細 CSV
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section D: セラピスト別集計テーブル
// ---------------------------------------------------------------------------

function TherapistBreakdownTable({ data }: { data: TherapistBreakdownResult }) {
  if (data.rows.length === 0) {
    return <EmptyState message="該当するデータがありません" />;
  }

  const totalDone = data.rows.reduce((s, r) => s + r.doneCount, 0);
  const totalNomination = data.rows.reduce((s, r) => s + r.nominationCount, 0);
  const totalAmount = data.rows.reduce((s, r) => s + r.totalAmount, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-adm-border bg-adm-bg">
            <th className="text-left px-3 py-2 font-medium text-adm-text">セラピスト</th>
            <th className="text-right px-3 py-2 font-medium text-adm-text">完了件数</th>
            <th className="text-right px-3 py-2 font-medium text-adm-text">指名件数</th>
            <th className="text-right px-3 py-2 font-medium text-adm-text">売上合計</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr
              key={row.therapistId}
              className="border-b border-adm-border bg-adm-surface hover:bg-adm-bg"
            >
              <td className="px-3 py-2 text-adm-text">{row.therapistName}</td>
              <td className="px-3 py-2 text-right text-adm-text tabular-nums">
                {row.doneCount}件
              </td>
              <td className="px-3 py-2 text-right text-adm-text tabular-nums">
                {row.nominationCount}件
              </td>
              <td className="px-3 py-2 text-right text-adm-text tabular-nums">
                {fmtMoney(row.totalAmount)}
              </td>
            </tr>
          ))}
          {/* 合計行 */}
          <tr className="border-b border-adm-border font-semibold bg-adm-bg">
            <td className="px-3 py-2 text-adm-text">合計</td>
            <td className="px-3 py-2 text-right text-adm-text tabular-nums">{totalDone}件</td>
            <td className="px-3 py-2 text-right text-adm-text tabular-nums">{totalNomination}件</td>
            <td className="px-3 py-2 text-right text-adm-text tabular-nums">{fmtMoney(totalAmount)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function AnalyticsClient({ areas }: Props) {
  const { fromDate: defaultFrom, toDate: defaultTo } = thisMonthRange();
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const [areaId, setAreaId] = useState<string>('');

  const [reconciliation, setReconciliation] = useState<ReconciliationResult | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapResult | null>(null);
  const [therapistBreakdown, setTherapistBreakdown] = useState<TherapistBreakdownResult | null>(null);
  const [recError, setRecError] = useState<string | null>(null);
  const [heatError, setHeatError] = useState<string | null>(null);
  const [therapistError, setTherapistError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = useCallback(() => {
    setHasSearched(true);
    setRecError(null);
    setHeatError(null);
    setTherapistError(null);
    const fromISO = toISO(fromDate, true);
    const toISO_ = toISO(toDate, true);
    const params = {
      fromISO,
      toISO: toISO_,
      areaId: areaId || null,
    };
    startTransition(async () => {
      const [recResult, heatResult, therapistResult] = await Promise.all([
        getReconciliation(params),
        getDemandHeatmap(params),
        getTherapistBreakdown({ fromISO, toISO: toISO_ }),
      ]);
      if (recResult.ok && recResult.data) {
        setReconciliation(recResult.data);
      } else {
        setReconciliation(null);
        setRecError(recResult.error ?? '突合の取得に失敗しました');
      }
      if (heatResult.ok && heatResult.data) {
        setHeatmap(heatResult.data);
      } else {
        setHeatmap(null);
        setHeatError(heatResult.error ?? 'ヒートマップの取得に失敗しました');
      }
      if (therapistResult.ok && therapistResult.data) {
        setTherapistBreakdown(therapistResult.data);
      } else {
        setTherapistBreakdown(null);
        setTherapistError(therapistResult.error ?? 'セラピスト別集計の取得に失敗しました');
      }
    });
  }, [fromDate, toDate, areaId]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* フィルタバー */}
      <div
        className="p-4 bg-adm-surface border border-adm-border"
        style={{ borderRadius: '4px' }}
      >
        <div className="flex flex-wrap gap-4 items-end">
          {/* 期間 from */}
          <div className="flex flex-col gap-1">
            <label htmlFor="analytics-from" className="text-xs font-medium text-adm-text">
              開始日
            </label>
            <input
              id="analytics-from"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="px-2 py-1.5 text-sm border border-adm-border bg-adm-surface text-adm-text"
              style={{ borderRadius: '4px', outline: 'none' }}
            />
          </div>

          {/* 期間 to */}
          <div className="flex flex-col gap-1">
            <label htmlFor="analytics-to" className="text-xs font-medium text-adm-text">
              終了日（翌月1日 = その月全体）
            </label>
            <input
              id="analytics-to"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="px-2 py-1.5 text-sm border border-adm-border bg-adm-surface text-adm-text"
              style={{ borderRadius: '4px', outline: 'none' }}
            />
          </div>

          {/* エリア */}
          <div className="flex flex-col gap-1">
            <label htmlFor="analytics-area" className="text-xs font-medium text-adm-text">
              エリア
            </label>
            <select
              id="analytics-area"
              value={areaId}
              onChange={(e) => setAreaId(e.target.value)}
              className="px-2 py-1.5 text-sm border border-adm-border bg-adm-surface text-adm-text"
              style={{ borderRadius: '4px', outline: 'none' }}
            >
              <option value="">全エリア</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          {/* 当日ボタン */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-adm-text opacity-0 select-none" aria-hidden>
              ショートカット
            </span>
            <button
              type="button"
              onClick={() => {
                const today = todayJST();
                setFromDate(today);
                setToDate(today);
              }}
              disabled={isPending}
              className="px-3 py-1.5 text-sm border border-adm-border bg-adm-surface text-adm-text hover:bg-adm-bg transition-colors disabled:opacity-50"
              style={{ borderRadius: '4px' }}
            >
              当日
            </button>
          </div>

          {/* 検索ボタン */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-adm-text opacity-0 select-none" aria-hidden>
              実行
            </span>
            <button
              type="button"
              onClick={handleSearch}
              disabled={isPending}
              className="px-4 py-1.5 text-sm bg-adm-primary text-white disabled:opacity-50 transition-colors hover:opacity-90"
              style={{ borderRadius: '4px', backgroundColor: '#3F7A6B' }}
            >
              {isPending ? '集計中...' : '集計する'}
            </button>
          </div>
        </div>
      </div>

      {/* ローディング */}
      {isPending && <Spinner />}

      {/* 未検索 */}
      {!isPending && !hasSearched && (
        <EmptyState message="期間とエリアを選択して「集計する」を押してください" />
      )}

      {/* Section A: エリア別粗利（突合） */}
      {!isPending && hasSearched && (
        <section>
          <h2 className="text-base font-semibold text-adm-text mb-3">
            エリア別粗利（突合）
          </h2>
          {recError ? (
            <ErrorBanner message={recError} />
          ) : reconciliation ? (
            <div className="border border-adm-border bg-adm-surface" style={{ borderRadius: '4px' }}>
              <ReconciliationTable data={reconciliation} />
            </div>
          ) : (
            <EmptyState message="データがありません" />
          )}
        </section>
      )}

      {/* Section B: 需要ヒートマップ */}
      {!isPending && hasSearched && (
        <section className="pt-2 border-t border-adm-border">
          <h2 className="text-base font-semibold text-adm-text mb-3">
            需要ヒートマップ（曜日 × エリア）
          </h2>
          {heatError ? (
            <ErrorBanner message={heatError} />
          ) : heatmap ? (
            <div className="border border-adm-border bg-adm-surface p-4" style={{ borderRadius: '4px' }}>
              <DemandHeatmap data={heatmap} />
            </div>
          ) : (
            <EmptyState message="データがありません" />
          )}
        </section>
      )}

      {/* Section D: セラピスト別集計 */}
      {!isPending && hasSearched && (
        <section className="pt-2 border-t border-adm-border">
          <h2 className="text-base font-semibold text-adm-text mb-3">
            セラピスト別集計
          </h2>
          {therapistError ? (
            <ErrorBanner message={therapistError} />
          ) : therapistBreakdown ? (
            <div className="border border-adm-border bg-adm-surface" style={{ borderRadius: '4px' }}>
              <TherapistBreakdownTable data={therapistBreakdown} />
            </div>
          ) : (
            <EmptyState message="データがありません" />
          )}
        </section>
      )}

      {/* Section C: CSV ダウンロード */}
      {hasSearched && (
        <section className="pt-2 border-t border-adm-border">
          <h2 className="text-base font-semibold text-adm-text mb-3">CSV ダウンロード</h2>
          <CsvDownloadSection fromDate={fromDate} toDate={toDate} />
        </section>
      )}
    </div>
  );
}
