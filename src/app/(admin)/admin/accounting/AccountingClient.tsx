'use client';

/**
 * 会計クライアントコンポーネント（フェーズ17 / spec 10章 L853-869・11-6）。
 * 完了条件「前受金・ポイント引当・売上・経費が分けて出る」を 4 区分カードで体現。
 * 5 セクション構成:
 *   A. 会計サマリー（4区分: 売上 / ポイント引当 / 前受金 / 経費）
 *   B. 未計上の完了予約一覧 + 計上ボタン
 *   C. 経費入力 + 一覧
 *   （回数券発行 UI は発注者判断で当面非提供。バックエンドは温存 / 判断ログ #26）
 * any 禁止・金額整数。空状態・ローディング・エラーの3状態。
 */

import { useState, useTransition } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import {
  getAccountingSummary,
  postReservationRevenue,
  addExpense,
  listExpenses,
  listUnpostedDoneReservations,
} from '@/lib/accounting/actions';
import type { AccountingSummary, ExpenseItem, UnpostedReservation } from '@/lib/accounting/actions';

const TZ = 'Asia/Tokyo';

// ---- ラベル定義 ----
const LINE_TYPE_LABEL: Record<string, string> = {
  course: 'コース',
  option: 'オプション',
  nomination: '指名',
  transport: '交通費',
  midnight: '深夜加算',
  discount: '値引',
  point_use: 'ポイント利用',
  ticket_redeem: '回数券消化',
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: '現金',
  card: 'カード',
  emoney: '電子マネー',
  ticket: '回数券',
  point: 'ポイント',
};

const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  oil: 'オイル',
  supplies: '備品',
  parking: '駐車場代',
  ads: '広告費',
  other: 'その他',
};

// ---- 今月の from/to ----
function thisMonthRange(): { fromISO: string; toISO: string; fromDate: string; toDate: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const fromDate = `${y}-${String(m).padStart(2, '0')}-01`;
  // 翌月1日
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const toDate = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
  return {
    fromISO: `${fromDate}T00:00:00+09:00`,
    toISO: `${toDate}T00:00:00+09:00`,
    fromDate,
    toDate,
  };
}

interface AreaOption { id: string; name: string }
interface TherapistOption { id: string; name: string }

interface Props {
  areas: AreaOption[];
  therapists: TherapistOption[];
  initialUnpostedReservations: UnpostedReservation[];
  unpostedError: string | null;
}

export function AccountingClient({
  areas,
  therapists,
  initialUnpostedReservations,
  unpostedError,
}: Props) {
  // ====== Section A: 会計サマリー ======
  const init = thisMonthRange();
  const [fromDate, setFromDate] = useState(init.fromDate);
  const [toDate, setToDate] = useState(init.toDate);
  const [filterAreaId, setFilterAreaId] = useState('');
  const [filterTherapistId, setFilterTherapistId] = useState('');
  const [summary, setSummary] = useState<AccountingSummary | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [summaryPending, startSummaryTransition] = useTransition();

  function handleLoadSummary() {
    setSummaryError('');
    if (!fromDate || !toDate) {
      setSummaryError('期間を入力してください');
      return;
    }
    startSummaryTransition(async () => {
      const res = await getAccountingSummary({
        fromISO: `${fromDate}T00:00:00+09:00`,
        toISO: `${toDate}T00:00:00+09:00`,
        areaId: filterAreaId || undefined,
        therapistId: filterTherapistId || undefined,
      });
      if (res.ok && res.data) {
        setSummary(res.data);
      } else {
        setSummaryError(res.error ?? '集計の取得に失敗しました');
      }
    });
  }

  // ====== Section B: 未計上予約 ======
  const [unposted, setUnposted] = useState<UnpostedReservation[]>(initialUnpostedReservations);
  const [postMsg, setPostMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [postPending, startPostTransition] = useTransition();

  function handlePostRevenue(reservationId: string) {
    setPostingId(reservationId);
    setPostMsg(null);
    startPostTransition(async () => {
      const res = await postReservationRevenue({ reservationId });
      if (res.ok) {
        setUnposted((prev) => prev.filter((r) => r.id !== reservationId));
        setPostMsg({ ok: true, text: '売上を計上しました' });
      } else {
        setPostMsg({ ok: false, text: res.error ?? '計上に失敗しました' });
      }
      setPostingId(null);
    });
  }

  async function handleRefreshUnposted() {
    const res = await listUnpostedDoneReservations();
    if (res.ok && res.data) setUnposted(res.data);
  }

  // ====== Section C: 経費 ======
  const [expCategory, setExpCategory] = useState<
    'oil' | 'supplies' | 'parking' | 'ads' | 'other'
  >('oil');
  const [expAmountStr, setExpAmountStr] = useState('');
  const [expDate, setExpDate] = useState(init.fromDate);
  const [expAreaId, setExpAreaId] = useState('');
  const [expNote, setExpNote] = useState('');
  const [expMsg, setExpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [expPending, startExpTransition] = useTransition();

  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [expListError, setExpListError] = useState('');
  const [expListPending, startExpListTransition] = useTransition();
  const [expListFromDate, setExpListFromDate] = useState(init.fromDate);
  const [expListToDate, setExpListToDate] = useState(init.toDate);

  function handleAddExpense() {
    const amount = parseInt(expAmountStr, 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      setExpMsg({ ok: false, text: '金額は正の整数で入力してください' });
      return;
    }
    if (!expDate) {
      setExpMsg({ ok: false, text: '日付を入力してください' });
      return;
    }
    setExpMsg(null);
    startExpTransition(async () => {
      const res = await addExpense({
        category: expCategory,
        amount,
        spentOn: expDate,
        areaId: expAreaId || undefined,
        note: expNote || undefined,
      });
      if (res.ok) {
        setExpMsg({ ok: true, text: '経費を登録しました' });
        setExpAmountStr('');
        setExpNote('');
      } else {
        setExpMsg({ ok: false, text: res.error ?? '登録に失敗しました' });
      }
    });
  }

  function handleLoadExpenses() {
    setExpListError('');
    startExpListTransition(async () => {
      const res = await listExpenses({
        fromDate: expListFromDate,
        toDate: expListToDate,
        areaId: expAreaId || undefined,
      });
      if (res.ok && res.data) {
        setExpenses(res.data);
      } else {
        setExpListError(res.error ?? '経費の取得に失敗しました');
      }
    });
  }

  // 回数券発行 UI は発注者判断で当面非提供（バックエンドは温存 / 判断ログ #26）。

  // ====== 共通ヘルパ ======
  function yen(n: number) {
    return `¥${n.toLocaleString()}`;
  }

  return (
    <div className="space-y-10">

      {/* ===== Section A: 会計サマリー ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4" style={{ borderRadius: '4px' }}>
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          会計サマリー
        </h2>

        {/* フィルタ行 */}
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-adm-muted mb-1">期間（開始）</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            />
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">期間（終了・翌日0時）</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            />
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">エリア</label>
            <select
              value={filterAreaId}
              onChange={(e) => setFilterAreaId(e.target.value)}
              className="border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            >
              <option value="">全エリア</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">セラピスト</label>
            <select
              value={filterTherapistId}
              onChange={(e) => setFilterTherapistId(e.target.value)}
              className="border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            >
              <option value="">全セラピスト</option>
              {therapists.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleLoadSummary}
            disabled={summaryPending}
            className="bg-adm-primary text-white px-5 py-2 rounded text-sm disabled:opacity-50"
            style={{ borderRadius: '4px' }}
          >
            {summaryPending ? '集計中…' : '集計する'}
          </button>
        </div>

        {summaryError && (
          <p className="text-sm text-adm-danger">{summaryError}</p>
        )}

        {/* ローディング */}
        {summaryPending && (
          <p className="text-sm text-adm-muted">集計中…</p>
        )}

        {/* 空状態 */}
        {!summaryPending && !summary && !summaryError && (
          <p className="text-sm text-adm-muted py-4">
            期間を指定して「集計する」を押してください
          </p>
        )}

        {/* 4区分カード（完了条件「分けて出る」の主眼） */}
        {summary && !summaryPending && (
          <div className="space-y-6">
            {/* カード行: 売上 / ポイント引当 / 前受金 / 経費 */}
            <div className="grid grid-cols-4 gap-4">

              {/* 売上カード */}
              <div className="border border-adm-border rounded p-4 space-y-1" style={{ borderRadius: '4px' }}>
                <p className="text-xs font-semibold text-adm-muted uppercase tracking-wide">売上</p>
                <p className="text-2xl font-bold text-adm-text">
                  {yen(summary.revenue.total)}
                </p>
                <p className="text-xs text-adm-muted">revenue_lines 集計</p>
              </div>

              {/* ポイント引当カード */}
              <div className="border border-adm-border rounded p-4 space-y-1" style={{ borderRadius: '4px' }}>
                <p className="text-xs font-semibold text-adm-muted uppercase tracking-wide">ポイント引当</p>
                <p className="text-2xl font-bold text-adm-primary">
                  {summary.pointLiability.liability.toLocaleString()}P
                </p>
                <p className="text-xs text-adm-muted">期末時点の全社引当残</p>
              </div>

              {/* 前受金カード */}
              <div className="border border-adm-border rounded p-4 space-y-1" style={{ borderRadius: '4px' }}>
                <p className="text-xs font-semibold text-adm-muted uppercase tracking-wide">前受金（回数券残）</p>
                <p className="text-2xl font-bold text-adm-caution">
                  {yen(summary.deferredRevenue.deferredAmount)}
                </p>
                <p className="text-xs text-adm-muted">
                  残{summary.deferredRevenue.remainingCount}回分
                </p>
              </div>

              {/* 経費カード */}
              <div className="border border-adm-border rounded p-4 space-y-1" style={{ borderRadius: '4px' }}>
                <p className="text-xs font-semibold text-adm-muted uppercase tracking-wide">経費</p>
                <p className="text-2xl font-bold text-adm-danger">
                  {yen(summary.expenses.total)}
                </p>
                <p className="text-xs text-adm-muted">期間内合計</p>
              </div>
            </div>

            {/* 粗利（参考） */}
            <div className="border border-adm-border rounded p-4 flex items-center gap-6" style={{ borderRadius: '4px' }}>
              <div>
                <p className="text-xs text-adm-muted">粗利（売上−経費）</p>
                <p className={`text-xl font-bold ${summary.settlement.grossProfit >= 0 ? 'text-adm-primary' : 'text-adm-danger'}`}>
                  {yen(summary.settlement.grossProfit)}
                </p>
              </div>
              <div className="text-xs text-adm-muted">
                ※ バック（セラピスト報酬）はフェーズ18 で計上予定
              </div>
            </div>

            {/* 売上内訳: 行種別 */}
            <div className="grid grid-cols-2 gap-6">
              <div>
                <h3 className="text-sm font-semibold text-adm-text mb-3 border-b border-adm-border pb-1">
                  売上内訳（行種別）
                </h3>
                <table className="w-full text-sm border-collapse">
                  <tbody>
                    {(Object.entries(summary.revenue.byType) as [string, number][])
                      .filter(([, v]) => v !== 0)
                      .map(([type, amount]) => (
                        <tr key={type} className="border-b border-adm-border last:border-0">
                          <td className="py-1 pr-3 text-adm-muted">
                            {LINE_TYPE_LABEL[type] ?? type}
                          </td>
                          <td className={`py-1 text-right font-mono font-medium ${amount < 0 ? 'text-adm-danger' : 'text-adm-text'}`}>
                            {amount < 0 ? '−' : ''}{yen(Math.abs(amount))}
                          </td>
                        </tr>
                      ))}
                    {Object.values(summary.revenue.byType).every((v) => v === 0) && (
                      <tr>
                        <td colSpan={2} className="py-2 text-adm-muted text-xs">
                          この期間の売上行はありません
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* 支払方法内訳 */}
              <div>
                <h3 className="text-sm font-semibold text-adm-text mb-3 border-b border-adm-border pb-1">
                  支払方法内訳
                </h3>
                <table className="w-full text-sm border-collapse">
                  <tbody>
                    {(Object.entries(summary.payments.byMethod) as [string, number][])
                      .filter(([, v]) => v !== 0)
                      .map(([method, amount]) => (
                        <tr key={method} className="border-b border-adm-border last:border-0">
                          <td className="py-1 pr-3 text-adm-muted">
                            {PAYMENT_METHOD_LABEL[method] ?? method}
                          </td>
                          <td className="py-1 text-right font-mono font-medium text-adm-text">
                            {yen(amount)}
                          </td>
                        </tr>
                      ))}
                    {Object.values(summary.payments.byMethod).every((v) => v === 0) && (
                      <tr>
                        <td colSpan={2} className="py-2 text-adm-muted text-xs">
                          この期間の支払記録はありません
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ポイント引当内訳 */}
            <div>
              <h3 className="text-sm font-semibold text-adm-text mb-3 border-b border-adm-border pb-1">
                ポイント引当内訳（全社・期末時点）
              </h3>
              <div className="flex gap-8 text-sm">
                <div>
                  <span className="text-adm-muted">付与累計</span>
                  <span className="ml-2 font-mono font-medium text-adm-text">
                    {summary.pointLiability.earned.toLocaleString()}P
                  </span>
                </div>
                <div>
                  <span className="text-adm-muted">利用累計</span>
                  <span className="ml-2 font-mono font-medium text-adm-text">
                    {summary.pointLiability.used.toLocaleString()}P
                  </span>
                </div>
                <div>
                  <span className="text-adm-muted">失効累計</span>
                  <span className="ml-2 font-mono font-medium text-adm-text">
                    {summary.pointLiability.expired.toLocaleString()}P
                  </span>
                </div>
                <div>
                  <span className="text-adm-muted">調整</span>
                  <span className="ml-2 font-mono font-medium text-adm-text">
                    {summary.pointLiability.adjusted.toLocaleString()}P
                  </span>
                </div>
                <div>
                  <span className="text-adm-muted font-semibold">引当残</span>
                  <span className="ml-2 font-mono font-bold text-adm-primary">
                    {summary.pointLiability.liability.toLocaleString()}P
                  </span>
                </div>
              </div>
            </div>

            {/* 経費内訳 */}
            <div>
              <h3 className="text-sm font-semibold text-adm-text mb-3 border-b border-adm-border pb-1">
                経費内訳（カテゴリ別）
              </h3>
              <div className="flex flex-wrap gap-6 text-sm">
                {(Object.entries(summary.expenses.byCategory) as [string, number][])
                  .map(([cat, amount]) => (
                    <div key={cat}>
                      <span className="text-adm-muted">{EXPENSE_CATEGORY_LABEL[cat] ?? cat}</span>
                      <span className="ml-2 font-mono font-medium text-adm-text">
                        {yen(amount)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ===== Section B: 未計上の完了予約 ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4" style={{ borderRadius: '4px' }}>
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2 flex items-center justify-between">
          <span>未計上の完了予約</span>
          <button
            onClick={handleRefreshUnposted}
            className="text-xs px-3 py-1 border border-adm-border rounded text-adm-muted"
            style={{ borderRadius: '4px' }}
          >
            更新
          </button>
        </h2>

        {postMsg && (
          <p className={`text-sm ${postMsg.ok ? 'text-green-700' : 'text-adm-danger'}`}>
            {postMsg.text}
          </p>
        )}

        {unpostedError && (
          <p className="text-sm text-adm-danger">{unpostedError}</p>
        )}

        {/* 空状態 */}
        {!unpostedError && unposted.length === 0 && (
          <p className="text-sm text-adm-muted py-4">
            未計上の完了予約はありません
          </p>
        )}

        {unposted.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-adm-border text-adm-muted text-left">
                  <th className="py-1 pr-3">日時</th>
                  <th className="py-1 pr-3">顧客</th>
                  <th className="py-1 pr-3">セラピスト</th>
                  <th className="py-1 pr-3">コース</th>
                  <th className="py-1 pr-3 text-right">金額</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {unposted.map((r) => (
                  <tr key={r.id} className="border-b border-adm-border last:border-0">
                    <td className="py-1.5 pr-3 text-adm-muted whitespace-nowrap">
                      {formatInTimeZone(new Date(r.startAtISO), TZ, 'MM/dd HH:mm')}
                    </td>
                    <td className="py-1.5 pr-3">{r.customerName ?? '—'}</td>
                    <td className="py-1.5 pr-3">{r.therapistName ?? '—'}</td>
                    <td className="py-1.5 pr-3">{r.courseName}</td>
                    <td className="py-1.5 pr-3 text-right font-mono font-medium">
                      {yen(r.totalAmount)}
                    </td>
                    <td className="py-1.5">
                      <button
                        onClick={() => handlePostRevenue(r.id)}
                        disabled={postPending && postingId === r.id}
                        className="bg-adm-primary text-white px-3 py-1 rounded text-xs disabled:opacity-50 whitespace-nowrap"
                        style={{ borderRadius: '4px' }}
                      >
                        {postPending && postingId === r.id ? '計上中…' : '売上を計上'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ===== Section C: 経費 ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-6" style={{ borderRadius: '4px' }}>
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          経費入力
        </h2>

        {/* 入力フォーム */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-adm-muted mb-1">
              カテゴリ <span className="text-adm-danger">*</span>
            </label>
            <select
              value={expCategory}
              onChange={(e) =>
                setExpCategory(e.target.value as 'oil' | 'supplies' | 'parking' | 'ads' | 'other')
              }
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            >
              {Object.entries(EXPENSE_CATEGORY_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">
              金額（円） <span className="text-adm-danger">*</span>
            </label>
            <input
              type="number"
              min="1"
              step="1"
              value={expAmountStr}
              onChange={(e) => setExpAmountStr(e.target.value)}
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            />
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">
              日付 <span className="text-adm-danger">*</span>
            </label>
            <input
              type="date"
              value={expDate}
              onChange={(e) => setExpDate(e.target.value)}
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            />
          </div>
          <div>
            <label className="block text-xs text-adm-muted mb-1">エリア（任意）</label>
            <select
              value={expAreaId}
              onChange={(e) => setExpAreaId(e.target.value)}
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            >
              <option value="">指定なし</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-adm-muted mb-1">メモ（任意）</label>
            <input
              type="text"
              value={expNote}
              onChange={(e) => setExpNote(e.target.value)}
              maxLength={500}
              placeholder="例: 〇〇店 オイル補充"
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            />
          </div>
        </div>

        {expMsg && (
          <p className={`text-sm ${expMsg.ok ? 'text-green-700' : 'text-adm-danger'}`}>
            {expMsg.text}
          </p>
        )}

        <button
          onClick={handleAddExpense}
          disabled={expPending}
          className="bg-adm-primary text-white px-5 py-2 rounded text-sm disabled:opacity-50"
          style={{ borderRadius: '4px' }}
        >
          {expPending ? '登録中…' : '経費を登録する'}
        </button>

        {/* 経費一覧 */}
        <div className="border-t border-adm-border pt-4 space-y-3">
          <h3 className="text-sm font-semibold text-adm-text">経費一覧</h3>
          <div className="flex gap-3 items-end flex-wrap">
            <div>
              <label className="block text-xs text-adm-muted mb-1">期間（開始）</label>
              <input
                type="date"
                value={expListFromDate}
                onChange={(e) => setExpListFromDate(e.target.value)}
                className="border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                style={{ borderRadius: '4px' }}
              />
            </div>
            <div>
              <label className="block text-xs text-adm-muted mb-1">期間（終了）</label>
              <input
                type="date"
                value={expListToDate}
                onChange={(e) => setExpListToDate(e.target.value)}
                className="border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                style={{ borderRadius: '4px' }}
              />
            </div>
            <button
              onClick={handleLoadExpenses}
              disabled={expListPending}
              className="bg-adm-primary text-white px-4 py-2 rounded text-sm disabled:opacity-50"
              style={{ borderRadius: '4px' }}
            >
              {expListPending ? '取得中…' : '一覧を取得'}
            </button>
          </div>

          {expListError && (
            <p className="text-sm text-adm-danger">{expListError}</p>
          )}

          {!expListPending && expenses.length === 0 && !expListError && (
            <p className="text-sm text-adm-muted">「一覧を取得」を押すと経費が表示されます</p>
          )}

          {expenses.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-adm-border text-adm-muted text-left">
                    <th className="py-1 pr-3">日付</th>
                    <th className="py-1 pr-3">カテゴリ</th>
                    <th className="py-1 pr-3 text-right">金額</th>
                    <th className="py-1">メモ</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((e) => (
                    <tr key={e.id} className="border-b border-adm-border last:border-0">
                      <td className="py-1.5 pr-3 text-adm-muted">{e.spentOn}</td>
                      <td className="py-1.5 pr-3">{EXPENSE_CATEGORY_LABEL[e.category] ?? e.category}</td>
                      <td className="py-1.5 pr-3 text-right font-mono font-medium">{yen(e.amount)}</td>
                      <td className="py-1.5 text-adm-muted max-w-xs truncate">{e.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-adm-border font-semibold">
                    <td colSpan={2} className="py-1.5 pr-3 text-adm-muted text-right">合計</td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      {yen(expenses.reduce((s, e) => s + e.amount, 0))}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </section>

    </div>
  );
}
