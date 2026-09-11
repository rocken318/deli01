'use client';

import { useState, useTransition } from 'react';
import {
  createOption,
  updateOption,
  deleteOption,
  listOptionsAdmin,
} from '@/lib/options/actions';
import type { OptionRow } from '@/lib/options/actions';

interface Props {
  initialOptions: OptionRow[];
  loadError?: string;
  canWrite: boolean;
}

interface FormState {
  name: string;
  description: string;
  price: number;
  durationMin: number;
  backType: 'rate' | 'fixed';
  backValue: number;
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
}

const emptyForm: FormState = {
  name: '',
  description: '',
  price: 0,
  durationMin: 0,
  backType: 'rate',
  backValue: 0,
  isPublic: true,
  isActive: true,
  sortOrder: 0,
};

export function OptionsClient({ initialOptions, loadError, canWrite }: Props) {
  const [options, setOptions] = useState<OptionRow[]>(initialOptions);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const inputCls =
    'w-full border border-adm-border rounded px-3 py-2 text-sm bg-adm-surface focus:outline-none focus:ring-1 focus:ring-adm-primary';
  const btnPrimary =
    'px-4 py-2 bg-adm-primary text-white text-sm rounded hover:opacity-90 disabled:opacity-50';
  const btnSecondary =
    'px-3 py-2 border border-adm-border text-sm rounded hover:bg-adm-bg disabled:opacity-50';
  const btnDanger =
    'px-2 py-1 text-xs border border-adm-danger text-adm-danger rounded hover:bg-adm-danger/10 disabled:opacity-50';

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(row: OptionRow) {
    setEditingId(row.id);
    setForm({
      name: row.name,
      description: row.description ?? '',
      price: row.price,
      durationMin: row.durationMin,
      backType: row.backType,
      backValue: row.backValue,
      isPublic: row.isPublic,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    });
    setFormError(null);
    setShowForm(true);
  }

  async function refreshList() {
    const r = await listOptionsAdmin();
    if (r.ok && r.data) setOptions(r.data);
  }

  function handleSubmit() {
    setFormError(null);
    startTransition(async () => {
      if (editingId) {
        const r = await updateOption({
          id: editingId,
          name: form.name,
          description: form.description || null,
          price: form.price,
          durationMin: form.durationMin,
          backType: form.backType,
          backValue: form.backValue,
          isPublic: form.isPublic,
          isActive: form.isActive,
          sortOrder: form.sortOrder,
        });
        if (!r.ok) { setFormError(r.error ?? '更新に失敗しました'); return; }
        setOptions((prev) =>
          prev.map((o) =>
            o.id === editingId
              ? {
                  ...o,
                  name: form.name,
                  description: form.description || null,
                  price: form.price,
                  durationMin: form.durationMin,
                  backType: form.backType,
                  backValue: form.backValue,
                  isPublic: form.isPublic,
                  isActive: form.isActive,
                  sortOrder: form.sortOrder,
                }
              : o,
          ),
        );
      } else {
        const r = await createOption({
          name: form.name,
          description: form.description || undefined,
          price: form.price,
          durationMin: form.durationMin,
          backType: form.backType,
          backValue: form.backValue,
          isPublic: form.isPublic,
          isActive: form.isActive,
          sortOrder: form.sortOrder,
        });
        if (!r.ok) { setFormError(r.error ?? '登録に失敗しました'); return; }
        await refreshList();
      }
      setShowForm(false);
    });
  }

  function handleDelete(id: string) {
    if (!confirm('このオプションを削除しますか？')) return;
    startTransition(async () => {
      const r = await deleteOption(id);
      if (!r.ok) { alert(r.error ?? '削除に失敗しました'); return; }
      setOptions((prev) => prev.filter((o) => o.id !== id));
      if (editingId === id) setShowForm(false);
    });
  }

  return (
    <div className="flex gap-4 items-start">
      {/* 左: オプション一覧 */}
      <div className="w-64 flex-shrink-0 bg-adm-surface border border-adm-border rounded-lg p-2">
        {canWrite && (
          <button
            type="button"
            className="w-full mb-2 py-2 border border-dashed border-adm-primary rounded text-adm-primary text-xs font-bold hover:bg-adm-primary/5 disabled:opacity-50"
            onClick={openCreate}
            disabled={isPending}
          >
            ＋ オプション追加
          </button>
        )}

        {loadError && (
          <p className="text-xs text-adm-danger px-2 py-1">{loadError}</p>
        )}

        {options.length === 0 ? (
          <p className="text-xs text-adm-text/50 py-4 text-center">登録なし</p>
        ) : (
          <ul className="space-y-1">
            {options.map((o) => (
              <li
                key={o.id}
                className={`px-2 py-2 rounded cursor-pointer ${
                  editingId === o.id && showForm
                    ? 'bg-adm-primary/10'
                    : 'hover:bg-adm-bg'
                }`}
                onClick={() => openEdit(o)}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-sm font-bold text-adm-text truncate">{o.name}</span>
                  <span className="text-xs text-adm-muted shrink-0">
                    ¥{o.price.toLocaleString()}
                  </span>
                </div>
                <div className="flex gap-2 mt-0.5">
                  <span className="text-xs text-adm-muted">{o.durationMin}分</span>
                  {!o.isActive && (
                    <span className="text-xs text-adm-danger font-bold">停止中</span>
                  )}
                  {!o.isPublic && (
                    <span className="text-xs text-adm-muted">非公開</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 右: 編集フォーム */}
      {showForm && canWrite && (
        <div className="flex-1 min-w-0 bg-adm-surface border border-adm-border rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-adm-text">
            {editingId ? `${form.name} の編集` : '新規オプション登録'}
          </h2>

          {formError && (
            <p className="text-xs text-adm-danger border border-adm-danger/30 rounded px-3 py-2">
              {formError}
            </p>
          )}

          {/* 基本情報 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-bold text-adm-muted mb-1">オプション名 *</label>
              <input
                className={inputCls}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例: アロマオプション"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-bold text-adm-muted mb-1">説明</label>
              <textarea
                className={inputCls}
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="例: アロマオイルを使用したオプションコース"
              />
            </div>
          </div>

          {/* 料金・時間 */}
          <div className="grid grid-cols-2 gap-3 border-t border-adm-border pt-3">
            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">料金（円）*</label>
              <input
                type="number"
                className={inputCls}
                value={form.price}
                min={0}
                step={1}
                onChange={(e) =>
                  setForm((f) => ({ ...f, price: parseInt(e.target.value, 10) || 0 }))
                }
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">所要時間（分）</label>
              <input
                type="number"
                className={inputCls}
                value={form.durationMin}
                min={0}
                step={1}
                onChange={(e) =>
                  setForm((f) => ({ ...f, durationMin: parseInt(e.target.value, 10) || 0 }))
                }
              />
            </div>
          </div>

          {/* バック設定 */}
          <div className="grid grid-cols-2 gap-3 border-t border-adm-border pt-3">
            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">バック種別</label>
              <select
                className={inputCls}
                value={form.backType}
                onChange={(e) =>
                  setForm((f) => ({ ...f, backType: e.target.value as 'rate' | 'fixed' }))
                }
              >
                <option value="rate">率（%）</option>
                <option value="fixed">固定額（円）</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">
                バック値（{form.backType === 'rate' ? '%' : '円'}）
              </label>
              <input
                type="number"
                className={inputCls}
                value={form.backValue}
                min={0}
                max={form.backType === 'rate' ? 100 : undefined}
                step={1}
                onChange={(e) =>
                  setForm((f) => ({ ...f, backValue: parseInt(e.target.value, 10) || 0 }))
                }
              />
            </div>
          </div>

          {/* その他設定 */}
          <div className="grid grid-cols-3 gap-3 border-t border-adm-border pt-3">
            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">並び順</label>
              <input
                type="number"
                className={inputCls}
                value={form.sortOrder}
                min={0}
                step={1}
                onChange={(e) =>
                  setForm((f) => ({ ...f, sortOrder: parseInt(e.target.value, 10) || 0 }))
                }
              />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input
                type="checkbox"
                id="optionIsPublic"
                checked={form.isPublic}
                onChange={(e) => setForm((f) => ({ ...f, isPublic: e.target.checked }))}
              />
              <label htmlFor="optionIsPublic" className="text-sm text-adm-text">公開</label>
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input
                type="checkbox"
                id="optionIsActive"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              <label htmlFor="optionIsActive" className="text-sm text-adm-text">有効</label>
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
                  このオプションを削除
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {!showForm && (
        <div className="flex-1 min-w-0 bg-adm-surface border border-adm-border rounded-lg p-8 flex items-center justify-center">
          <p className="text-sm text-adm-text/50">
            {canWrite
              ? '「＋ オプション追加」または一覧から編集するオプションを選んでください'
              : '一覧からオプションを選んでください'}
          </p>
        </div>
      )}
    </div>
  );
}
