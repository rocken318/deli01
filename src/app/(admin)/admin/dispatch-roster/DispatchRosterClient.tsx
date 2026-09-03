'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  createTaxiCompany,
  updateTaxiCompany,
  deleteTaxiCompany,
  postDriverMessage,
  deleteDriverMessage,
} from '@/lib/dispatch-roster/actions';
import type { TaxiCompanyRow, DriverMessageRow } from '@/lib/dispatch-roster/actions';

interface Props {
  initialTaxiCompanies: TaxiCompanyRow[];
  initialMessages: DriverMessageRow[];
  taxiError?: string;
  messageError?: string;
  canWrite: boolean;
}

export function DispatchRosterClient({
  initialTaxiCompanies,
  initialMessages,
  taxiError,
  messageError,
  canWrite,
}: Props) {
  const [taxis, setTaxis] = useState<TaxiCompanyRow[]>(initialTaxiCompanies);
  const [messages, setMessages] = useState<DriverMessageRow[]>(initialMessages);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [msgBody, setMsgBody] = useState('');
  const [msgError, setMsgError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const emptyTaxi = { name: '', phone: '', shiftNote: '', note: '', sortOrder: 0, isActive: true };
  const [form, setForm] = useState(emptyTaxi);

  function openCreate() {
    setEditingId(null);
    setForm(emptyTaxi);
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(row: TaxiCompanyRow) {
    setEditingId(row.id);
    setForm({
      name: row.name,
      phone: row.phone ?? '',
      shiftNote: row.shiftNote ?? '',
      note: row.note ?? '',
      sortOrder: row.sortOrder,
      isActive: row.isActive,
    });
    setFormError(null);
    setShowForm(true);
  }

  function handleSubmit() {
    setFormError(null);
    startTransition(async () => {
      if (editingId) {
        const r = await updateTaxiCompany({
          id: editingId,
          name: form.name,
          phone: form.phone || null,
          shiftNote: form.shiftNote || null,
          note: form.note || null,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
        });
        if (!r.ok) { setFormError(r.error ?? '更新に失敗しました'); return; }
        setTaxis((prev) =>
          prev.map((t) =>
            t.id === editingId
              ? { ...t, name: form.name, phone: form.phone || null, shiftNote: form.shiftNote || null, note: form.note || null, sortOrder: form.sortOrder, isActive: form.isActive }
              : t,
          ),
        );
      } else {
        const r = await createTaxiCompany({
          name: form.name,
          phone: form.phone || undefined,
          shiftNote: form.shiftNote || undefined,
          note: form.note || undefined,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
        });
        if (!r.ok) { setFormError(r.error ?? '登録に失敗しました'); return; }
        if (r.data) {
          setTaxis((prev) => [
            ...prev,
            {
              id: r.data!.id,
              name: form.name,
              phone: form.phone || null,
              shiftNote: form.shiftNote || null,
              note: form.note || null,
              sortOrder: form.sortOrder,
              isActive: form.isActive,
            },
          ]);
        }
      }
      setShowForm(false);
    });
  }

  function handleDelete(id: string) {
    if (!confirm('このタクシー会社を削除しますか？')) return;
    startTransition(async () => {
      const r = await deleteTaxiCompany(id);
      if (!r.ok) { alert(r.error ?? '削除に失敗しました'); return; }
      setTaxis((prev) => prev.filter((t) => t.id !== id));
    });
  }

  function handlePostMessage() {
    if (!msgBody.trim()) return;
    setMsgError(null);
    startTransition(async () => {
      const r = await postDriverMessage({ body: msgBody.trim() });
      if (!r.ok) { setMsgError(r.error ?? '投稿に失敗しました'); return; }
      setMsgBody('');
      if (r.data) {
        setMessages((prev) => [
          { id: r.data!.id, body: msgBody.trim(), createdBy: null, createdAt: new Date().toISOString() },
          ...prev,
        ]);
      }
    });
  }

  function handleDeleteMessage(id: string) {
    if (!confirm('この伝言を削除しますか？')) return;
    startTransition(async () => {
      const r = await deleteDriverMessage(id);
      if (!r.ok) { alert(r.error ?? '削除に失敗しました'); return; }
      setMessages((prev) => prev.filter((m) => m.id !== id));
    });
  }

  const inputCls =
    'w-full border border-adm-border rounded px-3 py-2 text-sm bg-adm-surface focus:outline-none focus:ring-1 focus:ring-adm-primary';
  const btnPrimary =
    'px-4 py-2 bg-adm-primary text-white text-sm rounded hover:opacity-90 disabled:opacity-50';
  const btnSecondary =
    'px-3 py-2 border border-adm-border text-sm rounded hover:bg-adm-bg disabled:opacity-50';
  const btnDanger =
    'px-2 py-1 text-xs border border-adm-danger text-adm-danger rounded hover:bg-adm-danger/10 disabled:opacity-50';

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-adm-text">配車名簿</h1>
        <Link
          href="/admin/dispatch-board"
          className="text-sm text-adm-primary underline underline-offset-2"
        >
          配車ボードへ
        </Link>
      </div>

      {/* タクシー会社セクション */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-adm-text">タクシー会社一覧</h2>
          {canWrite && (
            <button type="button" className={btnPrimary} onClick={openCreate} disabled={isPending}>
              ＋ 追加
            </button>
          )}
        </div>

        {taxiError && (
          <p className="text-sm text-adm-danger border border-adm-danger/30 rounded px-3 py-2">
            {taxiError}
          </p>
        )}

        {showForm && canWrite && (
          <div className="border border-adm-border rounded p-4 space-y-3 bg-adm-bg">
            <p className="text-sm font-medium text-adm-text">{editingId ? '編集' : '新規登録'}</p>
            {formError && <p className="text-xs text-adm-danger">{formError}</p>}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-adm-text/70 mb-1">会社名 *</label>
                <input
                  className={inputCls}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="〇〇タクシー"
                />
              </div>
              <div>
                <label className="block text-xs text-adm-text/70 mb-1">電話番号</label>
                <input
                  className={inputCls}
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="0X0-XXXX-XXXX"
                />
              </div>
              <div>
                <label className="block text-xs text-adm-text/70 mb-1">受付メモ（曜日/時間）</label>
                <input
                  className={inputCls}
                  value={form.shiftNote}
                  onChange={(e) => setForm((f) => ({ ...f, shiftNote: e.target.value }))}
                  placeholder="平日8-22時受付"
                />
              </div>
              <div>
                <label className="block text-xs text-adm-text/70 mb-1">並び順</label>
                <input
                  type="number"
                  className={inputCls}
                  value={form.sortOrder}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, sortOrder: parseInt(e.target.value, 10) || 0 }))
                  }
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-adm-text/70 mb-1">備考（NG・車種等）</label>
                <textarea
                  className={inputCls}
                  rows={2}
                  value={form.note}
                  onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                  placeholder="NG車種、担当メモなど"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={form.isActive}
                  onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                />
                <label htmlFor="isActive" className="text-sm text-adm-text">
                  有効
                </label>
              </div>
            </div>
            <div className="flex gap-2">
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
            </div>
          </div>
        )}

        {taxis.length === 0 ? (
          <p className="text-sm text-adm-text/50 py-4 text-center">
            タクシー会社が登録されていません
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-adm-border text-adm-text/70 text-left">
                  <th className="pb-2 pr-4">会社名</th>
                  <th className="pb-2 pr-4">電話</th>
                  <th className="pb-2 pr-4">受付メモ</th>
                  <th className="pb-2 pr-4">備考</th>
                  <th className="pb-2 pr-4">状態</th>
                  {canWrite && <th className="pb-2">操作</th>}
                </tr>
              </thead>
              <tbody>
                {taxis.map((t) => (
                  <tr key={t.id} className="border-b border-adm-border/50 hover:bg-adm-bg">
                    <td className="py-2 pr-4 font-medium">{t.name}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{t.phone ?? '—'}</td>
                    <td className="py-2 pr-4 text-xs text-adm-text/70">{t.shiftNote ?? '—'}</td>
                    <td className="py-2 pr-4 text-xs text-adm-text/70 max-w-xs truncate">
                      {t.note ?? '—'}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          t.isActive
                            ? 'bg-adm-primary/10 text-adm-primary'
                            : 'bg-adm-border text-adm-text/50'
                        }`}
                      >
                        {t.isActive ? '有効' : '停止'}
                      </span>
                    </td>
                    {canWrite && (
                      <td className="py-2">
                        <div className="flex gap-1">
                          <button
                            type="button"
                            className={btnSecondary}
                            onClick={() => openEdit(t)}
                            disabled={isPending}
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            className={btnDanger}
                            onClick={() => handleDelete(t.id)}
                            disabled={isPending}
                          >
                            削除
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ドライバー伝言板セクション */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="font-medium text-adm-text">ドライバー伝言板</h2>

        <div className="space-y-2">
          <textarea
            className={inputCls}
            rows={2}
            value={msgBody}
            onChange={(e) => setMsgBody(e.target.value)}
            placeholder="全員への伝言を入力（例: 本日○○エリア渋滞注意）"
          />
          {msgError && <p className="text-xs text-adm-danger">{msgError}</p>}
          <button
            type="button"
            className={btnPrimary}
            onClick={handlePostMessage}
            disabled={isPending || !msgBody.trim()}
          >
            {isPending ? '投稿中…' : '投稿'}
          </button>
        </div>

        {messageError && (
          <p className="text-sm text-adm-danger border border-adm-danger/30 rounded px-3 py-2">
            {messageError}
          </p>
        )}

        {messages.length === 0 ? (
          <p className="text-sm text-adm-text/50 py-4 text-center">伝言はありません</p>
        ) : (
          <ul className="space-y-2">
            {messages.map((m) => (
              <li
                key={m.id}
                className="flex items-start justify-between gap-4 border-b border-adm-border/50 pb-2"
              >
                <div className="space-y-0.5 flex-1">
                  <p className="text-sm text-adm-text whitespace-pre-wrap">{m.body}</p>
                  <p className="text-xs text-adm-text/50">
                    {new Date(m.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                  </p>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    className={btnDanger}
                    onClick={() => handleDeleteMessage(m.id)}
                    disabled={isPending}
                  >
                    削除
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
