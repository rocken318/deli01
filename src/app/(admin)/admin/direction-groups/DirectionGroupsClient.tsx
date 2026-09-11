'use client';

import { useState, useTransition } from 'react';
import {
  createDirectionGroup,
  updateDirectionGroup,
  deleteDirectionGroup,
  listDirectionGroups,
} from '@/lib/dispatch-board/direction-actions';
import type { DirectionGroupRow } from '@/lib/dispatch-board/direction-actions';

interface Props {
  initialGroups: DirectionGroupRow[];
  loadError?: string;
  canWrite: boolean;
}

interface FormState {
  name: string;
  sortOrder: number;
  isActive: boolean;
}

const emptyForm: FormState = { name: '', sortOrder: 0, isActive: true };

const inputCls =
  'w-full border border-adm-border rounded px-3 py-2 text-sm bg-adm-surface focus:outline-none focus:ring-1 focus:ring-adm-primary';
const btnPrimary =
  'px-4 py-2 bg-adm-primary text-white text-sm rounded hover:opacity-90 disabled:opacity-50';
const btnSecondary =
  'px-3 py-2 border border-adm-border text-sm rounded hover:bg-adm-bg disabled:opacity-50';
const btnDanger =
  'px-2 py-1 text-xs border border-adm-danger text-adm-danger rounded hover:bg-adm-danger/10 disabled:opacity-50';

export function DirectionGroupsClient({ initialGroups, loadError, canWrite }: Props) {
  const [groups, setGroups] = useState<DirectionGroupRow[]>(initialGroups);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function refreshList() {
    const r = await listDirectionGroups();
    if (r.ok && r.data) setGroups(r.data);
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(row: DirectionGroupRow) {
    setEditingId(row.id);
    setForm({ name: row.name, sortOrder: row.sortOrder, isActive: row.isActive });
    setFormError(null);
    setShowForm(true);
  }

  function handleSubmit() {
    setFormError(null);
    startTransition(async () => {
      if (editingId) {
        const r = await updateDirectionGroup({
          id: editingId,
          name: form.name,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
        });
        if (!r.ok) { setFormError(r.error ?? '更新に失敗しました'); return; }
        setGroups((prev) =>
          prev.map((g) =>
            g.id === editingId
              ? { ...g, name: form.name, sortOrder: form.sortOrder, isActive: form.isActive }
              : g,
          ),
        );
      } else {
        const r = await createDirectionGroup({
          name: form.name,
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
    if (!confirm('この方面グループを削除しますか？')) return;
    startTransition(async () => {
      const r = await deleteDirectionGroup(id);
      if (!r.ok) { alert(r.error ?? '削除に失敗しました'); return; }
      setGroups((prev) => prev.filter((g) => g.id !== id));
      if (editingId === id) setShowForm(false);
    });
  }

  return (
    <div className="flex gap-4 items-start">
      {/* 左: 一覧 */}
      <div className="w-52 flex-shrink-0 bg-adm-surface border border-adm-border rounded-lg p-2">
        {canWrite && (
          <button
            type="button"
            className="w-full mb-2 py-2 border border-dashed border-adm-primary rounded text-adm-primary text-xs font-bold hover:bg-adm-primary/5 disabled:opacity-50"
            onClick={openCreate}
            disabled={isPending}
          >
            ＋ 方面グループ追加
          </button>
        )}

        {loadError && (
          <p className="text-xs text-adm-danger px-2 py-1">{loadError}</p>
        )}

        {groups.length === 0 ? (
          <p className="text-xs text-adm-text/50 py-4 text-center">登録なし</p>
        ) : (
          <ul className="space-y-1">
            {groups.map((g) => (
              <li
                key={g.id}
                className={`flex items-center gap-2 px-2 py-2 rounded cursor-pointer ${
                  editingId === g.id && showForm ? 'bg-adm-primary/10' : 'hover:bg-adm-bg'
                }`}
                onClick={() => openEdit(g)}
              >
                <div className="min-w-0">
                  <div className="text-sm font-bold text-adm-text truncate">{g.name}</div>
                  <div className="text-xs text-adm-muted">
                    並び順: {g.sortOrder}
                    {!g.isActive && (
                      <span className="ml-1 text-adm-danger">（無効）</span>
                    )}
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
          <h2 className="text-sm font-semibold text-adm-text">
            {editingId ? `${form.name} の編集` : '新規登録'}
          </h2>

          {formError && (
            <p className="text-xs text-adm-danger border border-adm-danger/30 rounded px-3 py-2">
              {formError}
            </p>
          )}

          <div>
            <label className="block text-xs font-bold text-adm-muted mb-1">名称 *</label>
            <input
              className={inputCls}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="泉区・松森方面"
            />
          </div>

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
                id="groupIsActive"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              <label htmlFor="groupIsActive" className="text-sm text-adm-text">有効</label>
            </div>
          </div>

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
                  削除
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
              ? '「＋ 方面グループ追加」または一覧から編集するグループを選んでください'
              : '一覧からグループを選んでください'}
          </p>
        </div>
      )}
    </div>
  );
}
