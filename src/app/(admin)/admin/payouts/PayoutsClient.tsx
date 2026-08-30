'use client';

/**
 * 報酬管理クライアントコンポーネント（フェーズ18 / spec 11章 L873-949）。
 * 4 セクション構成:
 *   A. 未計上の完了予約（done/noshow）一覧 + 計上ボタン
 *   B. レートグリッド（スコープ別表示 + 新規レート追加フォーム）
 *   C. 締め・支払フォーム
 *   D. 支払一覧 + 支払済み記録ボタン
 * any 禁止・金額整数。空状態・ローディング・エラーの3状態。
 */

import { useState, useTransition } from 'react';
import {
  postReservationPayout,
  getPayoutRatesGrid,
  upsertPayoutRate,
  closePayoutPeriod,
  markPayoutPaid,
} from '@/lib/payout/actions';
import type { PayoutRatesGrid } from '@/lib/payout/actions';

// ---- ラベル定義 ----

const TARGET_TYPE_LABEL: Record<string, string> = {
  course: 'コース',
  option: 'オプション',
  nomination: '指名料',
  transport: '交通費',
  late_night: '深夜加算',
  cancel_fee: 'キャンセル料',
};

const DEDUCTION_KIND_LABEL: Record<string, string> = {
  advance: '前払い',
  supplies: '備品・材料',
  loan: '貸付返済',
  withholding: '源泉徴収',
  other: 'その他',
};

const STATUS_LABEL: Record<string, string> = {
  open: '未締め',
  closed: '締め済み',
  paid: '支払済み',
};

type DeductionKind = 'advance' | 'supplies' | 'loan' | 'withholding' | 'other';
type TargetType = 'course' | 'option' | 'nomination' | 'transport' | 'late_night' | 'cancel_fee';
type CalcType = 'fixed' | 'rate';
type Scope = 'default' | 'rank' | 'individual';

interface UnpostedReservation {
  id: string;
  startLabel: string;
  therapistName: string;
  therapistId: string;
  therapistSlug: string;
  courseName: string;
  totalAmount: number;
  nominationFee: number;
  transportFee: number;
  status: string;
}

interface PayoutRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  gross: number;
  deductions: number;
  net: number;
  status: string;
  therapistName: string;
  therapistId: string;
}

interface DeductionEntry {
  kind: DeductionKind;
  amountStr: string;
  note: string;
}

interface Props {
  grid: PayoutRatesGrid;
  therapists: Array<{ id: string; name: string; slug: string }>;
  initialUnposted: UnpostedReservation[];
  initialPayouts: PayoutRow[];
  unpostedError: string | null;
}

function yen(n: number) {
  return `¥${n.toLocaleString()}`;
}

function statusBadge(status: string) {
  const label = STATUS_LABEL[status] ?? status;
  if (status === 'open') {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs bg-adm-bg text-adm-muted border border-adm-border" style={{ borderRadius: '4px' }}>
        {label}
      </span>
    );
  }
  if (status === 'closed') {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs text-adm-caution border border-adm-caution" style={{ borderRadius: '4px' }}>
        {label}
      </span>
    );
  }
  if (status === 'paid') {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs text-green-700 border border-green-600" style={{ borderRadius: '4px' }}>
        {label}
      </span>
    );
  }
  return <span className="text-xs text-adm-muted">{label}</span>;
}

export function PayoutsClient({
  grid: initialGrid,
  therapists,
  initialUnposted,
  initialPayouts,
  unpostedError,
}: Props) {
  // ====== Section A: 未計上の完了予約 ======
  const [unposted, setUnposted] = useState<UnpostedReservation[]>(initialUnposted);
  const [postMsg, setPostMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [postPending, startPostTransition] = useTransition();

  function handlePostPayout(reservationId: string) {
    setPostingId(reservationId);
    setPostMsg(null);
    startPostTransition(async () => {
      const res = await postReservationPayout({ reservationId });
      if (res.ok) {
        setUnposted((prev) => prev.filter((r) => r.id !== reservationId));
        setPostMsg({ ok: true, text: '報酬を計上しました' });
      } else {
        setPostMsg({ ok: false, text: res.error ?? '計上に失敗しました' });
      }
      setPostingId(null);
    });
  }

  // ====== Section B: レートグリッド ======
  const [grid, setGrid] = useState<PayoutRatesGrid>(initialGrid);
  const [showRateForm, setShowRateForm] = useState(false);

  // フォーム状態
  const [rateScope, setRateScope] = useState<Scope>('default');
  const [rateRankId, setRateRankId] = useState('');
  const [rateTherapistId, setRateTherapistId] = useState('');
  const [rateTargetType, setRateTargetType] = useState<TargetType>('course');
  const [rateCalcType, setRateCalcType] = useState<CalcType>('rate');
  const [rateValueStr, setRateValueStr] = useState('');
  const [rateEffectiveFrom, setRateEffectiveFrom] = useState('');
  const [rateNote, setRateNote] = useState('');
  const [rateMsg, setRateMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ratePending, startRateTransition] = useTransition();
  const [rateRefreshPending, startRateRefreshTransition] = useTransition();

  function handleUpsertRate() {
    const value = parseInt(rateValueStr, 10);
    if (!Number.isInteger(value) || value < 0) {
      setRateMsg({ ok: false, text: '値は0以上の整数を入力してください' });
      return;
    }
    if (!rateEffectiveFrom) {
      setRateMsg({ ok: false, text: '適用開始日を入力してください' });
      return;
    }
    if (rateScope === 'rank' && !rateRankId) {
      setRateMsg({ ok: false, text: 'ランクを選択してください' });
      return;
    }
    if (rateScope === 'individual' && !rateTherapistId) {
      setRateMsg({ ok: false, text: 'セラピストを選択してください' });
      return;
    }
    setRateMsg(null);
    startRateTransition(async () => {
      const res = await upsertPayoutRate({
        therapistId: rateScope === 'individual' ? rateTherapistId : null,
        rankId: rateScope === 'rank' ? rateRankId : null,
        targetType: rateTargetType,
        calcType: rateCalcType,
        value,
        effectiveFrom: rateEffectiveFrom,
        note: rateNote || null,
      });
      if (res.ok) {
        setRateMsg({ ok: true, text: 'レートを保存しました' });
        setRateValueStr('');
        setRateNote('');
        setShowRateForm(false);
        // グリッドを再取得
        startRateRefreshTransition(async () => {
          const refreshed = await getPayoutRatesGrid();
          if (refreshed.ok && refreshed.data) setGrid(refreshed.data);
        });
      } else {
        setRateMsg({ ok: false, text: res.error ?? 'レートの保存に失敗しました' });
      }
    });
  }

  // レートをスコープで分類
  const individualRates = grid.rates.filter((r) => r.therapistId != null);
  const rankRates = grid.rates.filter((r) => r.therapistId == null && r.rankId != null);
  const defaultRates = grid.rates.filter((r) => r.therapistId == null && r.rankId == null);

  function therapistNameById(id: string) {
    const t = therapists.find((x) => x.id === id);
    return t ? t.name : id;
  }

  function rankNameById(id: string) {
    const r = grid.ranks.find((x) => x.id === id);
    return r ? r.name : id;
  }

  // ====== Section C: 締め・支払 ======
  const [closeTherapistId, setCloseTherapistId] = useState('');
  const [closePeriodStart, setClosePeriodStart] = useState('');
  const [closePeriodEnd, setClosePeriodEnd] = useState('');
  const [deductions, setDeductions] = useState<DeductionEntry[]>([]);
  const [closeMsg, setCloseMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [closeResult, setCloseResult] = useState<{
    payoutId: string;
    gross: number;
    deductions: number;
    net: number;
    lineCount: number;
  } | null>(null);
  const [closePending, startCloseTransition] = useTransition();

  function addDeductionEntry() {
    if (deductions.length >= 5) return;
    setDeductions((prev) => [...prev, { kind: 'other', amountStr: '', note: '' }]);
  }

  function removeDeductionEntry(idx: number) {
    setDeductions((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateDeduction(idx: number, field: keyof DeductionEntry, val: string) {
    setDeductions((prev) =>
      prev.map((d, i) =>
        i === idx ? { ...d, [field]: field === 'kind' ? (val as DeductionKind) : val } : d,
      ),
    );
  }

  function handleClosePeriod() {
    if (!closeTherapistId) {
      setCloseMsg({ ok: false, text: 'セラピストを選択してください' });
      return;
    }
    if (!closePeriodStart || !closePeriodEnd) {
      setCloseMsg({ ok: false, text: '期間を入力してください' });
      return;
    }
    const parsedDeductions: Array<{ kind: DeductionKind; amount: number; note?: string }> = [];
    for (const d of deductions) {
      const amount = parseInt(d.amountStr, 10);
      if (!Number.isInteger(amount) || amount <= 0) {
        setCloseMsg({ ok: false, text: '控除金額は正の整数を入力してください' });
        return;
      }
      parsedDeductions.push({ kind: d.kind, amount, note: d.note || undefined });
    }
    setCloseMsg(null);
    setCloseResult(null);
    startCloseTransition(async () => {
      const res = await closePayoutPeriod({
        therapistId: closeTherapistId,
        periodStart: closePeriodStart,
        periodEnd: closePeriodEnd,
        deductions: parsedDeductions.length > 0 ? parsedDeductions : undefined,
      });
      if (res.ok && res.data) {
        setCloseMsg({ ok: true, text: '期間を締めました' });
        setCloseResult(res.data);
      } else {
        setCloseMsg({ ok: false, text: res.error ?? '締めに失敗しました' });
      }
    });
  }

  // ====== Section D: 支払一覧 ======
  const [payouts, setPayouts] = useState<PayoutRow[]>(initialPayouts);
  const [paidMsg, setPaidMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markPaidPending, startMarkPaidTransition] = useTransition();

  function handleMarkPaid(payoutId: string) {
    setMarkingId(payoutId);
    setPaidMsg(null);
    startMarkPaidTransition(async () => {
      const res = await markPayoutPaid({ payoutId });
      if (res.ok) {
        setPayouts((prev) =>
          prev.map((p) => (p.id === payoutId ? { ...p, status: 'paid' } : p)),
        );
        setPaidMsg({ ok: true, text: '支払済みに更新しました' });
      } else {
        setPaidMsg({ ok: false, text: res.error ?? '支払記録に失敗しました' });
      }
      setMarkingId(null);
    });
  }

  return (
    <div className="space-y-10">

      {/* ===== Section A: 未計上の完了予約 ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4" style={{ borderRadius: '4px' }}>
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          未計上の完了予約（done / noshow）
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
          <p className="text-sm text-adm-muted py-4">未計上の完了予約はありません</p>
        )}

        {unposted.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-adm-border text-adm-muted text-left">
                  <th className="py-1 pr-3">日時</th>
                  <th className="py-1 pr-3">セラピスト</th>
                  <th className="py-1 pr-3">コース</th>
                  <th className="py-1 pr-3 text-right">金額</th>
                  <th className="py-1 pr-3">ステータス</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {unposted.map((r) => (
                  <tr key={r.id} className="border-b border-adm-border last:border-0">
                    <td className="py-1.5 pr-3 text-adm-muted whitespace-nowrap font-mono text-xs">
                      {r.startLabel}
                    </td>
                    <td className="py-1.5 pr-3">{r.therapistName}</td>
                    <td className="py-1.5 pr-3">{r.courseName}</td>
                    <td className="py-1.5 pr-3 text-right font-mono font-medium">
                      {yen(r.totalAmount)}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-adm-muted">{r.status}</td>
                    <td className="py-1.5">
                      <button
                        onClick={() => handlePostPayout(r.id)}
                        disabled={postPending && postingId === r.id}
                        className="bg-adm-primary text-white px-3 py-1 rounded text-xs disabled:opacity-50 whitespace-nowrap"
                        style={{ borderRadius: '4px' }}
                      >
                        {postPending && postingId === r.id ? '計上中…' : '報酬を計上'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ===== Section B: レートグリッド ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4" style={{ borderRadius: '4px' }}>
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2 flex items-center justify-between">
          <span>報酬レートグリッド</span>
          <button
            onClick={() => { setShowRateForm((v) => !v); setRateMsg(null); }}
            className="text-xs px-3 py-1 border border-adm-primary text-adm-primary rounded"
            style={{ borderRadius: '4px' }}
          >
            {showRateForm ? 'キャンセル' : '新しいレート'}
          </button>
        </h2>

        {/* ローディング */}
        {rateRefreshPending && (
          <p className="text-sm text-adm-muted">レートを再取得中…</p>
        )}

        {/* 新規レートフォーム（インライン） */}
        {showRateForm && (
          <div className="border border-adm-border rounded p-4 space-y-4" style={{ borderRadius: '4px' }}>
            <h3 className="text-sm font-semibold text-adm-text">レートを追加 / 改定</h3>
            <div className="grid grid-cols-3 gap-3">
              {/* スコープ */}
              <div>
                <label className="block text-xs text-adm-muted mb-1">スコープ</label>
                <select
                  value={rateScope}
                  onChange={(e) => setRateScope(e.target.value as Scope)}
                  className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                  style={{ borderRadius: '4px' }}
                >
                  <option value="default">既定レート</option>
                  <option value="rank">ランク別</option>
                  <option value="individual">個別特例</option>
                </select>
              </div>

              {/* ランク or セラピスト */}
              {rateScope === 'rank' && (
                <div>
                  <label className="block text-xs text-adm-muted mb-1">ランク <span className="text-adm-danger">*</span></label>
                  <select
                    value={rateRankId}
                    onChange={(e) => setRateRankId(e.target.value)}
                    className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                    style={{ borderRadius: '4px' }}
                  >
                    <option value="">選択してください</option>
                    {grid.ranks.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {rateScope === 'individual' && (
                <div>
                  <label className="block text-xs text-adm-muted mb-1">セラピスト <span className="text-adm-danger">*</span></label>
                  <select
                    value={rateTherapistId}
                    onChange={(e) => setRateTherapistId(e.target.value)}
                    className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                    style={{ borderRadius: '4px' }}
                  >
                    <option value="">選択してください</option>
                    {therapists.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* 対象種別 */}
              <div>
                <label className="block text-xs text-adm-muted mb-1">対象種別</label>
                <select
                  value={rateTargetType}
                  onChange={(e) => setRateTargetType(e.target.value as TargetType)}
                  className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                  style={{ borderRadius: '4px' }}
                >
                  {Object.entries(TARGET_TYPE_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>

              {/* 計算タイプ */}
              <div>
                <label className="block text-xs text-adm-muted mb-1">計算タイプ</label>
                <select
                  value={rateCalcType}
                  onChange={(e) => setRateCalcType(e.target.value as CalcType)}
                  className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                  style={{ borderRadius: '4px' }}
                >
                  <option value="rate">率（%）</option>
                  <option value="fixed">固定（円）</option>
                </select>
              </div>

              {/* 値 */}
              <div>
                <label className="block text-xs text-adm-muted mb-1">
                  値 {rateCalcType === 'rate' ? '(0〜100 %)' : '(円 整数)'} <span className="text-adm-danger">*</span>
                </label>
                <input
                  type="number"
                  min="0"
                  max={rateCalcType === 'rate' ? 100 : undefined}
                  step="1"
                  value={rateValueStr}
                  onChange={(e) => setRateValueStr(e.target.value)}
                  className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                  style={{ borderRadius: '4px' }}
                />
              </div>

              {/* 適用開始日 */}
              <div>
                <label className="block text-xs text-adm-muted mb-1">適用開始日 <span className="text-adm-danger">*</span></label>
                <input
                  type="date"
                  value={rateEffectiveFrom}
                  onChange={(e) => setRateEffectiveFrom(e.target.value)}
                  className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                  style={{ borderRadius: '4px' }}
                />
              </div>

              {/* メモ */}
              <div className="col-span-3">
                <label className="block text-xs text-adm-muted mb-1">メモ（任意）</label>
                <input
                  type="text"
                  value={rateNote}
                  onChange={(e) => setRateNote(e.target.value)}
                  maxLength={200}
                  placeholder="例: 特別契約 2025年4月改定"
                  className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
                  style={{ borderRadius: '4px' }}
                />
              </div>
            </div>

            {rateMsg && (
              <p className={`text-sm ${rateMsg.ok ? 'text-green-700' : 'text-adm-danger'}`}>
                {rateMsg.text}
              </p>
            )}

            <button
              onClick={handleUpsertRate}
              disabled={ratePending}
              className="bg-adm-primary text-white px-5 py-2 rounded text-sm disabled:opacity-50"
              style={{ borderRadius: '4px' }}
            >
              {ratePending ? '保存中…' : 'レートを保存'}
            </button>
          </div>
        )}

        {/* ---- 個別特例 ---- */}
        {individualRates.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-adm-text">個別特例</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-adm-border text-adm-muted text-left">
                    <th className="py-1 pr-3">セラピスト</th>
                    <th className="py-1 pr-3">対象</th>
                    <th className="py-1 pr-3">計算</th>
                    <th className="py-1 pr-3">値</th>
                    <th className="py-1 pr-3">適用開始</th>
                    <th className="py-1 pr-3">終了</th>
                    <th className="py-1">メモ</th>
                  </tr>
                </thead>
                <tbody>
                  {individualRates.map((r) => {
                    const defaultMatch = defaultRates.find(
                      (d) => d.targetType === r.targetType && d.effectiveTo == null,
                    );
                    const isException =
                      defaultMatch != null &&
                      (defaultMatch.calcType !== r.calcType || defaultMatch.value !== r.value);
                    return (
                      <tr key={r.id} className="border-b border-adm-border last:border-0">
                        <td className="py-1.5 pr-3">
                          {r.therapistId ? therapistNameById(r.therapistId) : '—'}
                        </td>
                        <td className="py-1.5 pr-3">
                          {TARGET_TYPE_LABEL[r.targetType] ?? r.targetType}
                        </td>
                        <td className="py-1.5 pr-3 text-adm-muted text-xs">
                          {r.calcType === 'rate' ? '率%' : '固定円'}
                        </td>
                        <td className="py-1.5 pr-3 font-mono font-medium">
                          {r.calcType === 'rate' ? `${r.value}%` : yen(r.value)}
                          {isException && (
                            <span className="ml-1 text-xs px-1 py-0.5 rounded text-amber-700 border border-amber-500" style={{ borderRadius: '4px' }}>
                              特例
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-adm-muted text-xs font-mono">{r.effectiveFrom}</td>
                        <td className="py-1.5 pr-3 text-adm-muted text-xs font-mono">
                          {r.effectiveTo ?? <span className="text-green-700">有効中</span>}
                        </td>
                        <td className="py-1.5 text-adm-muted text-xs max-w-xs truncate">{r.note ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ---- ランク別 ---- */}
        {rankRates.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-adm-text">ランク別レート</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-adm-border text-adm-muted text-left">
                    <th className="py-1 pr-3">ランク</th>
                    <th className="py-1 pr-3">対象</th>
                    <th className="py-1 pr-3">計算</th>
                    <th className="py-1 pr-3">値</th>
                    <th className="py-1 pr-3">適用開始</th>
                    <th className="py-1 pr-3">終了</th>
                    <th className="py-1">メモ</th>
                  </tr>
                </thead>
                <tbody>
                  {rankRates.map((r) => (
                    <tr key={r.id} className="border-b border-adm-border last:border-0">
                      <td className="py-1.5 pr-3">
                        {r.rankId ? rankNameById(r.rankId) : '—'}
                      </td>
                      <td className="py-1.5 pr-3">
                        {TARGET_TYPE_LABEL[r.targetType] ?? r.targetType}
                      </td>
                      <td className="py-1.5 pr-3 text-adm-muted text-xs">
                        {r.calcType === 'rate' ? '率%' : '固定円'}
                      </td>
                      <td className="py-1.5 pr-3 font-mono font-medium">
                        {r.calcType === 'rate' ? `${r.value}%` : yen(r.value)}
                      </td>
                      <td className="py-1.5 pr-3 text-adm-muted text-xs font-mono">{r.effectiveFrom}</td>
                      <td className="py-1.5 pr-3 text-adm-muted text-xs font-mono">
                        {r.effectiveTo ?? <span className="text-green-700">有効中</span>}
                      </td>
                      <td className="py-1.5 text-adm-muted text-xs max-w-xs truncate">{r.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ---- 既定レート ---- */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-adm-text">既定レート</h3>
          {defaultRates.length === 0 ? (
            <p className="text-sm text-adm-muted py-2">既定レートは設定されていません</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-adm-border text-adm-muted text-left">
                    <th className="py-1 pr-3">対象</th>
                    <th className="py-1 pr-3">計算</th>
                    <th className="py-1 pr-3">値</th>
                    <th className="py-1 pr-3">適用開始</th>
                    <th className="py-1 pr-3">終了</th>
                    <th className="py-1">メモ</th>
                  </tr>
                </thead>
                <tbody>
                  {defaultRates.map((r) => (
                    <tr key={r.id} className="border-b border-adm-border last:border-0">
                      <td className="py-1.5 pr-3">
                        {TARGET_TYPE_LABEL[r.targetType] ?? r.targetType}
                      </td>
                      <td className="py-1.5 pr-3 text-adm-muted text-xs">
                        {r.calcType === 'rate' ? '率%' : '固定円'}
                      </td>
                      <td className="py-1.5 pr-3 font-mono font-medium">
                        {r.calcType === 'rate' ? `${r.value}%` : yen(r.value)}
                      </td>
                      <td className="py-1.5 pr-3 text-adm-muted text-xs font-mono">{r.effectiveFrom}</td>
                      <td className="py-1.5 pr-3 text-adm-muted text-xs font-mono">
                        {r.effectiveTo ?? <span className="text-green-700">有効中</span>}
                      </td>
                      <td className="py-1.5 text-adm-muted text-xs max-w-xs truncate">{r.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 空状態 */}
        {grid.rates.length === 0 && (
          <p className="text-sm text-adm-muted py-4">レートは設定されていません。「新しいレート」から追加してください。</p>
        )}
      </section>

      {/* ===== Section C: 締め・支払 ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4" style={{ borderRadius: '4px' }}>
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          期間締め・支払処理
        </h2>

        <div className="grid grid-cols-3 gap-4">
          {/* セラピスト選択 */}
          <div>
            <label className="block text-xs text-adm-muted mb-1">セラピスト <span className="text-adm-danger">*</span></label>
            <select
              value={closeTherapistId}
              onChange={(e) => setCloseTherapistId(e.target.value)}
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            >
              <option value="">選択してください</option>
              {therapists.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          {/* 期間開始 */}
          <div>
            <label className="block text-xs text-adm-muted mb-1">期間開始 <span className="text-adm-danger">*</span></label>
            <input
              type="date"
              value={closePeriodStart}
              onChange={(e) => setClosePeriodStart(e.target.value)}
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            />
          </div>

          {/* 期間終了 */}
          <div>
            <label className="block text-xs text-adm-muted mb-1">期間終了 <span className="text-adm-danger">*</span></label>
            <input
              type="date"
              value={closePeriodEnd}
              onChange={(e) => setClosePeriodEnd(e.target.value)}
              className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: '4px' }}
            />
          </div>
        </div>

        {/* 控除 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-adm-muted">控除（任意、最大5件）</label>
            {deductions.length < 5 && (
              <button
                onClick={addDeductionEntry}
                className="text-xs px-2 py-0.5 border border-adm-border rounded text-adm-muted"
                style={{ borderRadius: '4px' }}
              >
                + 控除を追加
              </button>
            )}
          </div>
          {deductions.map((d, idx) => (
            <div key={idx} className="flex gap-3 items-end flex-wrap border border-adm-border rounded p-3" style={{ borderRadius: '4px' }}>
              <div>
                <label className="block text-xs text-adm-muted mb-1">種類</label>
                <select
                  value={d.kind}
                  onChange={(e) => updateDeduction(idx, 'kind', e.target.value)}
                  className="border border-adm-border rounded px-2 py-1.5 text-sm"
                  style={{ borderRadius: '4px' }}
                >
                  {Object.entries(DEDUCTION_KIND_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-adm-muted mb-1">金額（円）</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={d.amountStr}
                  onChange={(e) => updateDeduction(idx, 'amountStr', e.target.value)}
                  className="border border-adm-border rounded px-2 py-1.5 text-sm w-28"
                  style={{ borderRadius: '4px' }}
                />
              </div>
              <div className="flex-1 min-w-48">
                <label className="block text-xs text-adm-muted mb-1">メモ（任意）</label>
                <input
                  type="text"
                  value={d.note}
                  onChange={(e) => updateDeduction(idx, 'note', e.target.value)}
                  maxLength={200}
                  className="w-full border border-adm-border rounded px-2 py-1.5 text-sm"
                  style={{ borderRadius: '4px' }}
                />
              </div>
              <button
                onClick={() => removeDeductionEntry(idx)}
                className="text-adm-danger text-xs px-2 py-1.5"
              >
                削除
              </button>
            </div>
          ))}
        </div>

        {closeMsg && (
          <p className={`text-sm ${closeMsg.ok ? 'text-green-700' : 'text-adm-danger'}`}>
            {closeMsg.text}
          </p>
        )}

        <button
          onClick={handleClosePeriod}
          disabled={closePending}
          className="bg-adm-primary text-white px-5 py-2 rounded text-sm disabled:opacity-50"
          style={{ borderRadius: '4px' }}
        >
          {closePending ? '処理中…' : '期間を締める'}
        </button>

        {/* 締め結果 */}
        {closeResult && (
          <div className="border border-adm-border rounded p-4 space-y-2" style={{ borderRadius: '4px' }}>
            <h3 className="text-sm font-semibold text-adm-text">締め結果</h3>
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-xs text-adm-muted">支払ID</p>
                <p className="font-mono text-xs text-adm-text break-all">{closeResult.payoutId}</p>
              </div>
              <div>
                <p className="text-xs text-adm-muted">総額</p>
                <p className="font-mono font-medium text-adm-text">{yen(closeResult.gross)}</p>
              </div>
              <div>
                <p className="text-xs text-adm-muted">控除計</p>
                <p className="font-mono font-medium text-adm-danger">{yen(closeResult.deductions)}</p>
              </div>
              <div>
                <p className="text-xs text-adm-muted">手取り</p>
                <p className="font-mono font-bold text-adm-primary">{yen(closeResult.net)}</p>
              </div>
            </div>
            <p className="text-xs text-adm-muted">明細 {closeResult.lineCount} 件</p>
          </div>
        )}
      </section>

      {/* ===== Section D: 支払一覧 ===== */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4" style={{ borderRadius: '4px' }}>
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          支払一覧
        </h2>

        {paidMsg && (
          <p className={`text-sm ${paidMsg.ok ? 'text-green-700' : 'text-adm-danger'}`}>
            {paidMsg.text}
          </p>
        )}

        {/* 空状態 */}
        {payouts.length === 0 && (
          <p className="text-sm text-adm-muted py-4">支払記録はありません</p>
        )}

        {payouts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-adm-border text-adm-muted text-left">
                  <th className="py-1 pr-3">期間</th>
                  <th className="py-1 pr-3">セラピスト</th>
                  <th className="py-1 pr-3 text-right">支給額</th>
                  <th className="py-1 pr-3 text-right">控除</th>
                  <th className="py-1 pr-3 text-right">手取り</th>
                  <th className="py-1 pr-3">ステータス</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id} className="border-b border-adm-border last:border-0">
                    <td className="py-1.5 pr-3 text-adm-muted text-xs font-mono whitespace-nowrap">
                      {p.periodStart} 〜 {p.periodEnd}
                    </td>
                    <td className="py-1.5 pr-3">{p.therapistName}</td>
                    <td className="py-1.5 pr-3 text-right font-mono font-medium">
                      {yen(p.gross)}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-adm-danger">
                      {p.deductions > 0 ? `−${yen(p.deductions)}` : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono font-bold text-adm-primary">
                      {yen(p.net)}
                    </td>
                    <td className="py-1.5 pr-3">{statusBadge(p.status)}</td>
                    <td className="py-1.5">
                      {p.status === 'closed' && (
                        <button
                          onClick={() => handleMarkPaid(p.id)}
                          disabled={markPaidPending && markingId === p.id}
                          className="bg-adm-primary text-white px-3 py-1 rounded text-xs disabled:opacity-50 whitespace-nowrap"
                          style={{ borderRadius: '4px' }}
                        >
                          {markPaidPending && markingId === p.id ? '更新中…' : '支払済みにする'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  );
}
