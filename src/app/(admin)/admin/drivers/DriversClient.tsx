'use client';

import { useState, useTransition, useEffect, useCallback } from 'react';
import {
  createDriver,
  updateDriver,
  deleteDriver,
  listDrivers,
} from '@/lib/drivers/actions';
import type { DriverRow } from '@/lib/drivers/actions';
import {
  getDriverWeek,
  saveDriverWeek,
  copyPreviousWeek,
} from '@/lib/drivers/shift-actions';
import type { ShiftDay } from '@/lib/drivers/shift-actions';
import { mondayOf } from '@/domain/dispatch/driver-shifts';

const DOW_LABELS = ['月 MON', '火 TUE', '水 WED', '木 THU', '金 FRI', '土 SAT', '日 SUN'];

/** 当日を含む週の月曜 YYYY-MM-DD */
function currentWeekStart(): string {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  return mondayOf(iso);
}

/** YYYY-MM-DD を "M/D（曜）〜 M/D（曜）" 表示 */
function fmtWeekRange(monday: string): string {
  const WDAYS = ['月', '火', '水', '木', '金', '土', '日'];
  const d = new Date(`${monday}T12:00:00Z`);
  const sun = new Date(d);
  sun.setUTCDate(d.getUTCDate() + 6);
  const fmtD = (dt: Date, dow: number) =>
    `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}（${WDAYS[dow]}）`;
  return `${fmtD(d, 0)} 〜 ${fmtD(sun, 6)}`;
}

/** 月曜 YYYY-MM-DD を N 週ずらす */
function offsetWeek(monday: string, delta: number): string {
  const d = new Date(`${monday}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta * 7);
  return d.toISOString().slice(0, 10);
}

interface DayState {
  active: boolean;
  start: string;
  end: string;
}

const defaultDayState = (): DayState => ({ active: false, start: '11:00', end: '23:00' });
const emptyWeekDays = (): DayState[] => Array.from({ length: 7 }, defaultDayState);

const PALETTE: { hex: string; name: string }[] = [
  { hex: '#2B2B2B', name: '黒' },
  { hex: '#F5F5F5', name: '白' },
  { hex: '#C0C4C8', name: 'シルバー' },
  { hex: '#C0392B', name: '赤' },
  { hex: '#1F3A63', name: '紺' },
  { hex: '#2C6152', name: '緑' },
  { hex: '#7A5CB0', name: '紫' },
  { hex: '#C9B18A', name: 'ベージュ' },
  { hex: '#D8C39A', name: 'ブロンド' },
];

interface Props {
  initialDrivers: DriverRow[];
  loadError?: string;
  canWrite: boolean;
}

interface FormState {
  name: string;
  phone: string;
  ngNote: string;
  vehicleNumber: string;
  vehicleModel: string;
  vehicleColorHex: string;
  vehicleColorName: string;
  vehicleNote: string;
  sortOrder: number;
  isActive: boolean;
}

const emptyForm: FormState = {
  name: '',
  phone: '',
  ngNote: '',
  vehicleNumber: '',
  vehicleModel: '',
  vehicleColorHex: '',
  vehicleColorName: '',
  vehicleNote: '',
  sortOrder: 0,
  isActive: true,
};

export function DriversClient({ initialDrivers, loadError, canWrite }: Props) {
  const [drivers, setDrivers] = useState<DriverRow[]>(initialDrivers);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // --- 週次シフト state ---
  const [shiftWeek, setShiftWeek] = useState<string>(currentWeekStart);
  const [shiftDays, setShiftDays] = useState<DayState[]>(emptyWeekDays());
  const [shiftMemo, setShiftMemo] = useState('');
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [shiftSaved, setShiftSaved] = useState(false);

  const inputCls =
    'w-full border border-adm-border rounded px-3 py-2 text-sm bg-adm-surface focus:outline-none focus:ring-1 focus:ring-adm-primary';
  const btnPrimary =
    'px-4 py-2 bg-adm-primary text-white text-sm rounded hover:opacity-90 disabled:opacity-50';
  const btnSecondary =
    'px-3 py-2 border border-adm-border text-sm rounded hover:bg-adm-bg disabled:opacity-50';
  const btnDanger =
    'px-2 py-1 text-xs border border-adm-danger text-adm-danger rounded hover:bg-adm-danger/10 disabled:opacity-50';

  // シフトデータをサーバから取得してstateに反映する
  const loadShiftWeek = useCallback(async (driverId: string, week: string) => {
    setShiftLoading(true);
    setShiftError(null);
    const r = await getDriverWeek(driverId, week);
    setShiftLoading(false);
    if (!r.ok || !r.data) {
      setShiftError(r.error ?? 'シフトの読み込みに失敗しました');
      return;
    }
    setShiftMemo(r.data.memo);
    const next = emptyWeekDays();
    for (const d of r.data.days) {
      if (d.dow >= 0 && d.dow <= 6) {
        next[d.dow] = { active: true, start: d.start, end: d.end };
      }
    }
    setShiftDays(next);
  }, []);

  // editingId または週が変わったらリロード
  useEffect(() => {
    if (!editingId) return;
    void loadShiftWeek(editingId, shiftWeek);
  }, [editingId, shiftWeek, loadShiftWeek]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setShowForm(true);
    // シフト節はリセット（新規はドライバー保存後に表示）
    setShiftWeek(currentWeekStart());
    setShiftDays(emptyWeekDays());
    setShiftMemo('');
    setShiftError(null);
    setShiftSaved(false);
  }

  function openEdit(row: DriverRow) {
    setEditingId(row.id);
    setForm({
      name: row.name,
      phone: row.phone ?? '',
      ngNote: row.ngNote ?? '',
      vehicleNumber: row.vehicleNumber ?? '',
      vehicleModel: row.vehicleModel ?? '',
      vehicleColorHex: row.vehicleColorHex ?? '',
      vehicleColorName: row.vehicleColorName ?? '',
      vehicleNote: row.vehicleNote ?? '',
      sortOrder: row.sortOrder,
      isActive: row.isActive,
    });
    setFormError(null);
    setShowForm(true);
    // 週は今週から開始（useEffect がロードを担う）
    setShiftWeek(currentWeekStart());
    setShiftError(null);
    setShiftSaved(false);
  }

  async function refreshList() {
    const r = await listDrivers();
    if (r.ok && r.data) setDrivers(r.data);
  }

  function handleSubmit() {
    setFormError(null);
    startTransition(async () => {
      if (editingId) {
        const r = await updateDriver({
          id: editingId,
          name: form.name,
          phone: form.phone || null,
          ngNote: form.ngNote || null,
          vehicleNumber: form.vehicleNumber || null,
          vehicleModel: form.vehicleModel || null,
          vehicleColorHex: form.vehicleColorHex || null,
          vehicleColorName: form.vehicleColorName || null,
          vehicleNote: form.vehicleNote || null,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
        });
        if (!r.ok) { setFormError(r.error ?? '更新に失敗しました'); return; }
        setDrivers((prev) =>
          prev.map((d) =>
            d.id === editingId
              ? {
                  ...d,
                  name: form.name,
                  phone: form.phone || null,
                  ngNote: form.ngNote || null,
                  vehicleNumber: form.vehicleNumber || null,
                  vehicleModel: form.vehicleModel || null,
                  vehicleColorHex: form.vehicleColorHex || null,
                  vehicleColorName: form.vehicleColorName || null,
                  vehicleNote: form.vehicleNote || null,
                  sortOrder: form.sortOrder,
                  isActive: form.isActive,
                }
              : d,
          ),
        );
      } else {
        const r = await createDriver({
          name: form.name,
          phone: form.phone || undefined,
          ngNote: form.ngNote || undefined,
          vehicleNumber: form.vehicleNumber || undefined,
          vehicleModel: form.vehicleModel || undefined,
          vehicleColorHex: form.vehicleColorHex || undefined,
          vehicleColorName: form.vehicleColorName || undefined,
          vehicleNote: form.vehicleNote || undefined,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
        });
        if (!r.ok) { setFormError(r.error ?? '登録に失敗しました'); return; }
        await refreshList();
      }
      setShowForm(false);
    });
  }

  function handleDelete(id: string) {
    if (!confirm('このドライバーを削除しますか？')) return;
    startTransition(async () => {
      const r = await deleteDriver(id);
      if (!r.ok) { alert(r.error ?? '削除に失敗しました'); return; }
      setDrivers((prev) => prev.filter((d) => d.id !== id));
      if (editingId === id) setShowForm(false);
    });
  }

  function handleShiftSave() {
    if (!editingId) return;
    setShiftError(null);
    setShiftSaved(false);
    startTransition(async () => {
      const days: ShiftDay[] = shiftDays
        .map((d, dow) => ({ dow, start: d.start, end: d.end, active: d.active }))
        .filter((d) => d.active)
        .map(({ dow, start, end }) => ({ dow, start, end }));
      const r = await saveDriverWeek({
        driverId: editingId,
        weekStart: shiftWeek,
        memo: shiftMemo,
        days,
      });
      if (!r.ok) {
        setShiftError(r.error ?? 'シフトの保存に失敗しました');
        return;
      }
      setShiftSaved(true);
    });
  }

  function handleCopyPreviousWeek() {
    if (!editingId) return;
    setShiftError(null);
    setShiftSaved(false);
    startTransition(async () => {
      const r = await copyPreviousWeek(editingId, shiftWeek);
      if (!r.ok) {
        setShiftError(r.error ?? '前週コピーに失敗しました');
        return;
      }
      await loadShiftWeek(editingId, shiftWeek);
    });
  }

  function updateDayField(dow: number, field: 'start' | 'end', value: string) {
    setShiftDays((prev) =>
      prev.map((d, i) => (i === dow ? { ...d, [field]: value } : d)),
    );
    setShiftSaved(false);
  }

  function toggleDayActive(dow: number, active: boolean) {
    setShiftDays((prev) =>
      prev.map((d, i) => (i === dow ? { ...d, active } : d)),
    );
    setShiftSaved(false);
  }

  function selectPaletteColor(hex: string, name: string) {
    setForm((f) => ({ ...f, vehicleColorHex: hex, vehicleColorName: name }));
  }

  function handleCustomColor(hex: string) {
    setForm((f) => ({ ...f, vehicleColorHex: hex }));
  }

  const selectedPaletteEntry = PALETTE.find(
    (p) => p.hex.toLowerCase() === form.vehicleColorHex.toLowerCase(),
  );

  return (
    <div className="flex gap-4 items-start">
      {/* 左: ドライバー一覧 */}
      <div className="w-52 flex-shrink-0 bg-adm-surface border border-adm-border rounded-lg p-2">
        {canWrite && (
          <button
            type="button"
            className="w-full mb-2 py-2 border border-dashed border-adm-primary rounded text-adm-primary text-xs font-bold hover:bg-adm-primary/5 disabled:opacity-50"
            onClick={openCreate}
            disabled={isPending}
          >
            ＋ ドライバー追加
          </button>
        )}

        {loadError && (
          <p className="text-xs text-adm-danger px-2 py-1">{loadError}</p>
        )}

        {drivers.length === 0 ? (
          <p className="text-xs text-adm-text/50 py-4 text-center">
            登録なし
          </p>
        ) : (
          <ul className="space-y-1">
            {drivers.map((d) => (
              <li
                key={d.id}
                className={`flex items-center gap-2 px-2 py-2 rounded cursor-pointer ${
                  editingId === d.id && showForm
                    ? 'bg-adm-primary/10'
                    : 'hover:bg-adm-bg'
                }`}
                style={{ borderLeft: `4px solid ${d.vehicleColorHex ?? '#ccc'}` }}
                onClick={() => openEdit(d)}
              >
                <div className="min-w-0">
                  <div className="text-sm font-bold text-adm-text truncate">{d.name}</div>
                  <div className="text-xs text-adm-muted truncate">
                    {[d.vehicleNumber, d.vehicleModel].filter(Boolean).join(' ')}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 右: 編集フォーム */}
      {showForm && canWrite && (
        <div className="flex-1 min-w-0 bg-adm-surface border border-adm-border rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-adm-text flex items-center gap-2">
              {form.vehicleColorHex && (
                <span
                  className="inline-block w-3 h-3 rounded-full"
                  style={{ background: form.vehicleColorHex }}
                />
              )}
              {editingId ? `${form.name} の編集` : '新規登録'}
            </h2>
          </div>

          {formError && (
            <p className="text-xs text-adm-danger border border-adm-danger/30 rounded px-3 py-2">
              {formError}
            </p>
          )}

          {/* 基本情報 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">氏名 *</label>
              <input
                className={inputCls}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="畑山"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">携帯番号</label>
              <input
                className={inputCls}
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="080-0000-0000"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-adm-muted mb-1">NG項目 / 備考</label>
            <textarea
              className={inputCls}
              rows={2}
              value={form.ngNote}
              onChange={(e) => setForm((f) => ({ ...f, ngNote: e.target.value }))}
              placeholder="土曜固定。"
            />
          </div>

          {/* 車両セクション */}
          <div>
            <p className="text-xs font-bold text-adm-text border-t border-adm-border pt-3 mb-3">
              車両
            </p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-bold text-adm-muted mb-1">車番</label>
                <input
                  className={inputCls}
                  value={form.vehicleNumber}
                  onChange={(e) => setForm((f) => ({ ...f, vehicleNumber: e.target.value }))}
                  placeholder="6417"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-adm-muted mb-1">車種</label>
                <input
                  className={inputCls}
                  value={form.vehicleModel}
                  onChange={(e) => setForm((f) => ({ ...f, vehicleModel: e.target.value }))}
                  placeholder="ステップワゴン"
                />
              </div>
            </div>

            {/* 色パレット */}
            <label className="block text-xs font-bold text-adm-muted mb-2">
              車の色（配車ボードの色に使う）
            </label>
            <div className="flex flex-wrap gap-2 items-center mb-2">
              {PALETTE.map((p) => {
                const isSelected =
                  form.vehicleColorHex.toLowerCase() === p.hex.toLowerCase();
                return (
                  <button
                    key={p.hex}
                    type="button"
                    title={p.name}
                    onClick={() => selectPaletteColor(p.hex, p.name)}
                    className="relative flex-shrink-0"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: p.hex,
                      border: isSelected
                        ? '2px solid var(--adm-primary, #3F7A6B)'
                        : '2px solid transparent',
                      boxShadow: isSelected
                        ? 'inset 0 0 0 1px rgba(0,0,0,.12), 0 0 0 2px #fff, 0 0 0 4px #3F7A6B'
                        : 'inset 0 0 0 1px rgba(0,0,0,.12)',
                      cursor: 'pointer',
                    }}
                    aria-label={p.name}
                  />
                );
              })}
              {/* カスタム色 */}
              <div className="flex items-center gap-1 pl-2 border-l border-adm-border ml-1">
                <input
                  type="color"
                  value={form.vehicleColorHex || '#000000'}
                  onChange={(e) => handleCustomColor(e.target.value)}
                  className="w-8 h-8 rounded border border-adm-border bg-adm-surface cursor-pointer p-0.5"
                  title="カスタム色"
                />
                <span className="text-xs text-adm-muted">カスタム</span>
              </div>
            </div>

            {form.vehicleColorHex && (
              <p className="text-xs text-adm-muted mb-3">
                選択中:{' '}
                <strong>{selectedPaletteEntry ? selectedPaletteEntry.name : form.vehicleColorName || 'カスタム'}</strong>
                （{form.vehicleColorHex}）
              </p>
            )}

            {/* カスタム色の名称 */}
            {form.vehicleColorHex && !selectedPaletteEntry && (
              <div className="mb-3">
                <label className="block text-xs font-bold text-adm-muted mb-1">色の名称</label>
                <input
                  className={inputCls}
                  value={form.vehicleColorName}
                  onChange={(e) => setForm((f) => ({ ...f, vehicleColorName: e.target.value }))}
                  placeholder="例: ダークグレー"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">
                車の注意（乗車時に伝える等）
              </label>
              <textarea
                className={inputCls}
                rows={2}
                value={form.vehicleNote}
                onChange={(e) => setForm((f) => ({ ...f, vehicleNote: e.target.value }))}
                placeholder="例: シートベルトセンサーあり／自動ドア"
              />
            </div>
          </div>

          {/* その他 */}
          <div className="grid grid-cols-2 gap-3 border-t border-adm-border pt-3">
            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">並び順</label>
              <input
                type="number"
                className={inputCls}
                value={form.sortOrder}
                onChange={(e) =>
                  setForm((f) => ({ ...f, sortOrder: parseInt(e.target.value, 10) || 0 }))
                }
              />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input
                type="checkbox"
                id="driverIsActive"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              <label htmlFor="driverIsActive" className="text-sm text-adm-text">
                有効
              </label>
            </div>
          </div>

          {/* アクション */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              className={btnPrimary}
              onClick={handleSubmit}
              disabled={isPending}
            >
              {isPending ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className={btnSecondary}
              onClick={() => setShowForm(false)}
              disabled={isPending}
            >
              キャンセル
            </button>
            {editingId && (
              <>
                <div className="flex-1" />
                <button
                  type="button"
                  className={btnDanger}
                  onClick={() => handleDelete(editingId)}
                  disabled={isPending}
                >
                  このドライバーを削除
                </button>
              </>
            )}
          </div>

          {/* 週次シフト節（保存済みドライバーのみ） */}
          {editingId ? (
            <div className="border-t border-adm-border pt-4 mt-2 space-y-3">
              {/* ヘッダ：週ナビ + 前週コピー */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-adm-text">週次シフト</span>
                <div className="flex items-center gap-1 bg-adm-bg border border-adm-border rounded-lg px-2 py-1">
                  <button
                    type="button"
                    aria-label="前週"
                    className="text-adm-primary font-bold text-sm px-1 disabled:opacity-40"
                    onClick={() => setShiftWeek((w) => offsetWeek(w, -1))}
                    disabled={isPending || shiftLoading}
                  >
                    ◀
                  </button>
                  <span className="text-xs font-bold text-adm-text min-w-[11rem] text-center">
                    {fmtWeekRange(shiftWeek)}
                  </span>
                  <button
                    type="button"
                    aria-label="翌週"
                    className="text-adm-primary font-bold text-sm px-1 disabled:opacity-40"
                    onClick={() => setShiftWeek((w) => offsetWeek(w, 1))}
                    disabled={isPending || shiftLoading}
                  >
                    ▶
                  </button>
                </div>
                <button
                  type="button"
                  className="ml-auto inline-flex items-center gap-1 text-xs font-bold px-3 py-1.5 border border-adm-primary rounded-lg bg-adm-surface text-adm-primary hover:bg-adm-primary/5 disabled:opacity-50"
                  onClick={handleCopyPreviousWeek}
                  disabled={isPending || shiftLoading}
                >
                  ⧉ 前週をコピー（メモも一緒に）
                </button>
              </div>

              <p className="text-xs text-adm-muted">
                稼働にチェック → 時間入力 / 外す → 「休み」。27:00 等の25時超えOK。
              </p>

              {shiftLoading && (
                <p className="text-xs text-adm-muted animate-pulse">読み込み中…</p>
              )}
              {shiftError && (
                <p className="text-xs text-adm-danger border border-adm-danger/30 rounded px-3 py-2">
                  {shiftError}
                </p>
              )}
              {shiftSaved && (
                <p className="text-xs text-adm-primary border border-adm-primary/30 rounded px-3 py-2">
                  シフトを保存しました
                </p>
              )}

              {!shiftLoading && (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-adm-bg">
                      <th className="border border-adm-border px-2 py-1 text-xs text-adm-muted font-bold text-left w-20">曜日</th>
                      <th className="border border-adm-border px-2 py-1 text-xs text-adm-muted font-bold w-14">稼働</th>
                      <th className="border border-adm-border px-2 py-1 text-xs text-adm-muted font-bold text-left">稼働時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shiftDays.map((day, dow) => (
                      <tr key={dow}>
                        <td className="border border-adm-border px-2 py-1.5 text-xs font-bold bg-adm-bg/50">
                          {DOW_LABELS[dow]}
                        </td>
                        <td className="border border-adm-border px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={day.active}
                            onChange={(e) => toggleDayActive(dow, e.target.checked)}
                            className="w-4 h-4 accent-adm-primary cursor-pointer"
                          />
                        </td>
                        <td className="border border-adm-border px-2 py-1.5">
                          {day.active ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={day.start}
                                onChange={(e) => updateDayField(dow, 'start', e.target.value)}
                                className="w-16 border border-adm-border rounded px-1.5 py-1 text-xs text-center bg-adm-surface focus:outline-none focus:ring-1 focus:ring-adm-primary"
                                placeholder="11:00"
                              />
                              <span className="text-adm-muted text-xs px-1">〜</span>
                              <input
                                type="text"
                                value={day.end}
                                onChange={(e) => updateDayField(dow, 'end', e.target.value)}
                                className="w-16 border border-adm-border rounded px-1.5 py-1 text-xs text-center bg-adm-surface focus:outline-none focus:ring-1 focus:ring-adm-primary"
                                placeholder="23:00"
                              />
                            </div>
                          ) : (
                            <span className="text-xs text-adm-muted/60">休み</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* シフトメモ */}
              <div className="bg-[#FCFBF5] border border-[#E7DFBF] rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-adm-text">シフトメモ</span>
                  <span className="text-[10px] font-bold text-[#7a6a12] bg-[#F3EAC3] rounded-full px-2 py-0.5">翌週へ自動引き継ぎ</span>
                </div>
                <textarea
                  className="w-full border border-[#E0D7B0] rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#C9B18A] resize-y min-h-[40px]"
                  rows={2}
                  value={shiftMemo}
                  onChange={(e) => { setShiftMemo(e.target.value); setShiftSaved(false); }}
                  placeholder="例: 車検 9/23（水）・9月から火も休み"
                />
                <p className="text-[11px] text-[#8a7a34]">
                  消すまで毎週このメモが残ります（週を進めても引き継ぎ）。前週コピー時も一緒に複製。
                </p>
              </div>

              {/* シフト保存ボタン */}
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btnPrimary}
                  onClick={handleShiftSave}
                  disabled={isPending || shiftLoading}
                >
                  {isPending ? '保存中…' : 'シフトを保存'}
                </button>
              </div>
            </div>
          ) : (
            <div className="border-t border-adm-border pt-4 mt-2">
              <p className="text-xs text-adm-muted">
                週次シフトを登録するには、先にドライバーを保存してください。
              </p>
            </div>
          )}
        </div>
      )}

      {!showForm && (
        <div className="flex-1 min-w-0 bg-adm-surface border border-adm-border rounded-lg p-8 flex items-center justify-center">
          <p className="text-sm text-adm-text/50">
            {canWrite
              ? '「＋ ドライバー追加」または一覧から編集するドライバーを選んでください'
              : '一覧からドライバーを選んでください'}
          </p>
        </div>
      )}
    </div>
  );
}
