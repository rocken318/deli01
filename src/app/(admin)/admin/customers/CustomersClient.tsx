'use client';

import { useState, useTransition } from 'react';
import {
  searchCustomers,
  upsertCustomer,
  getCustomerDetail,
} from '@/lib/customers/actions';
import type { CustomerListRow, CustomerDetail } from '@/lib/customers/actions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(isoStr: string): string {
  return isoStr.slice(0, 10).replace(/-/g, '/');
}

function fmtStatus(status: string): string {
  const map: Record<string, string> = {
    confirmed: '確定',
    enroute: '移動中',
    in_service: '施術中',
    done: '完了',
    cancelled: 'キャンセル',
    held: '仮押さえ',
    no_show: '無断キャンセル',
  };
  return map[status] ?? status;
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface ProfileFormState {
  phone: string;
  name: string;
  nameKana: string;
  note: string;
}

const emptyForm: ProfileFormState = { phone: '', name: '', nameKana: '', note: '' };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  initialCustomers: CustomerListRow[];
  loadError?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CustomersClient({ initialCustomers, loadError }: Props) {
  const [customers, setCustomers] = useState<CustomerListRow[]>(initialCustomers);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // フォーム
  const [form, setForm] = useState<ProfileFormState>(emptyForm);
  const [isNewMode, setIsNewMode] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState(false);

  const [isPending, startTransition] = useTransition();

  const inputCls =
    'w-full border border-adm-border rounded px-3 py-2 text-sm bg-adm-surface focus:outline-none focus:ring-1 focus:ring-adm-primary';
  const btnPrimary =
    'px-4 py-2 bg-adm-primary text-white text-sm rounded hover:opacity-90 disabled:opacity-50';
  const btnSecondary =
    'px-3 py-2 border border-adm-border text-sm rounded hover:bg-adm-bg disabled:opacity-50';

  // ------------------------------------------------------------------
  // 検索
  // ------------------------------------------------------------------
  function handleSearch() {
    setSearchError(null);
    startTransition(async () => {
      const r = await searchCustomers(searchQuery);
      if (!r.ok) {
        setSearchError(r.error ?? '検索に失敗しました');
        return;
      }
      setCustomers(r.data ?? []);
    });
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSearch();
  }

  // ------------------------------------------------------------------
  // 顧客選択 → 詳細取得
  // ------------------------------------------------------------------
  async function selectCustomer(id: string) {
    setSelectedId(id);
    setIsNewMode(false);
    setFormError(null);
    setFormSuccess(false);
    setDetailError(null);
    setDetail(null);
    setDetailLoading(true);

    const r = await getCustomerDetail(id);
    setDetailLoading(false);
    if (!r.ok) {
      setDetailError(r.error ?? '詳細の取得に失敗しました');
      return;
    }
    setDetail(r.data ?? null);
    if (r.data) {
      setForm({
        phone: r.data.profile.phone,
        name: r.data.profile.name,
        nameKana: r.data.profile.nameKana ?? '',
        note: r.data.profile.note ?? '',
      });
    }
  }

  // ------------------------------------------------------------------
  // 新規登録モード
  // ------------------------------------------------------------------
  function openNewMode() {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setFormError(null);
    setFormSuccess(false);
    setForm(emptyForm);
    setIsNewMode(true);
  }

  // ------------------------------------------------------------------
  // 保存（新規 / 更新）
  // ------------------------------------------------------------------
  function handleSave() {
    setFormError(null);
    setFormSuccess(false);
    startTransition(async () => {
      const r = await upsertCustomer({
        id: isNewMode ? undefined : (selectedId ?? undefined),
        phone: form.phone,
        name: form.name,
        nameKana: form.nameKana || undefined,
        note: form.note || undefined,
      });

      if (!r.ok) {
        setFormError(r.error ?? '保存に失敗しました');
        return;
      }

      setFormSuccess(true);

      // 一覧をリフレッシュ
      const list = await searchCustomers(searchQuery);
      if (list.ok && list.data) setCustomers(list.data);

      // 新規作成後は作成した顧客を選択して詳細表示
      if (isNewMode && r.data?.id) {
        setIsNewMode(false);
        await selectCustomer(r.data.id);
      } else if (!isNewMode && selectedId) {
        // 更新後に詳細を再取得
        const refreshed = await getCustomerDetail(selectedId);
        if (refreshed.ok && refreshed.data) {
          setDetail(refreshed.data);
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  const showRightPane = isNewMode || selectedId !== null;

  return (
    <div className="flex gap-4 items-start">
      {/* 左パネル: 検索 + 一覧 */}
      <div className="w-60 flex-shrink-0 bg-adm-surface border border-adm-border rounded-lg p-3 space-y-3">
        {/* 検索入力 */}
        <div>
          <div className="flex gap-1">
            <input
              className="flex-1 border border-adm-border rounded px-2 py-1.5 text-sm bg-adm-surface focus:outline-none focus:ring-1 focus:ring-adm-primary"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="電話番号・名前で検索"
            />
            <button
              type="button"
              className="px-2 py-1.5 bg-adm-primary text-white text-xs rounded hover:opacity-90 disabled:opacity-50"
              onClick={handleSearch}
              disabled={isPending}
            >
              検索
            </button>
          </div>
          {searchError && (
            <p className="text-xs text-adm-danger mt-1">{searchError}</p>
          )}
        </div>

        {/* 新規ボタン */}
        <button
          type="button"
          className="w-full py-1.5 border border-dashed border-adm-primary rounded text-adm-primary text-xs font-bold hover:bg-adm-primary/5 disabled:opacity-50"
          onClick={openNewMode}
          disabled={isPending}
        >
          ＋ 新規顧客登録
        </button>

        {/* エラー */}
        {loadError && (
          <p className="text-xs text-adm-danger px-1">{loadError}</p>
        )}

        {/* 顧客一覧 */}
        {customers.length === 0 ? (
          <p className="text-xs text-adm-text/50 py-4 text-center">該当なし</p>
        ) : (
          <ul className="space-y-0.5">
            {customers.map((c) => (
              <li
                key={c.id}
                className={`px-2 py-2 rounded cursor-pointer ${
                  selectedId === c.id && !isNewMode
                    ? 'bg-adm-primary/10'
                    : 'hover:bg-adm-bg'
                }`}
                onClick={() => void selectCustomer(c.id)}
              >
                <div className="text-sm font-bold text-adm-text truncate">{c.name}</div>
                <div className="text-xs text-adm-muted truncate">{c.phone}</div>
                {c.nameKana && (
                  <div className="text-xs text-adm-muted/70 truncate">{c.nameKana}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 右パネル: 詳細 */}
      {showRightPane ? (
        <div className="flex-1 min-w-0 space-y-4">
          {/* プロフィール編集フォーム */}
          <div className="bg-adm-surface border border-adm-border rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-adm-text">
              {isNewMode ? '新規顧客登録' : '顧客情報'}
            </h2>

            {formError && (
              <p className="text-xs text-adm-danger border border-adm-danger/30 rounded px-3 py-2">
                {formError}
              </p>
            )}
            {formSuccess && (
              <p className="text-xs text-adm-primary border border-adm-primary/30 rounded px-3 py-2">
                保存しました
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-adm-muted mb-1">
                  電話番号 <span className="text-adm-danger">*</span>
                </label>
                <input
                  className={inputCls}
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="09012345678"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-adm-muted mb-1">
                  氏名 <span className="text-adm-danger">*</span>
                </label>
                <input
                  className={inputCls}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="山田 太郎"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-adm-muted mb-1">フリガナ</label>
                <input
                  className={inputCls}
                  value={form.nameKana}
                  onChange={(e) => setForm((f) => ({ ...f, nameKana: e.target.value }))}
                  placeholder="ヤマダ タロウ"
                />
              </div>
              <div>
                {/* spacer */}
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-adm-muted mb-1">メモ</label>
              <textarea
                className={inputCls}
                rows={3}
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="特記事項"
              />
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                className={btnPrimary}
                onClick={handleSave}
                disabled={isPending}
              >
                {isPending ? '保存中…' : '保存'}
              </button>
              {!isNewMode && (
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => {
                    setSelectedId(null);
                    setDetail(null);
                    setIsNewMode(false);
                  }}
                  disabled={isPending}
                >
                  閉じる
                </button>
              )}
            </div>
          </div>

          {/* 詳細セクション（既存顧客のみ） */}
          {!isNewMode && (
            <>
              {detailLoading && (
                <div className="bg-adm-surface border border-adm-border rounded-lg p-5">
                  <p className="text-sm text-adm-muted animate-pulse">読み込み中…</p>
                </div>
              )}

              {detailError && (
                <div className="bg-adm-surface border border-adm-danger/30 rounded-lg p-5">
                  <p className="text-sm text-adm-danger">{detailError}</p>
                </div>
              )}

              {detail && !detailLoading && (
                <>
                  {/* ポイント残高 */}
                  <div className="bg-adm-surface border border-adm-border rounded-lg p-5">
                    <h3 className="text-xs font-bold text-adm-muted mb-2">ポイント残高</h3>
                    <p className="text-2xl font-bold text-adm-primary">
                      {detail.pointsBalance.toLocaleString()}
                      <span className="text-sm font-normal text-adm-muted ml-1">P</span>
                    </p>
                  </div>

                  {/* 予約履歴 */}
                  <div className="bg-adm-surface border border-adm-border rounded-lg p-5">
                    <h3 className="text-xs font-bold text-adm-muted mb-3">
                      予約履歴（最新10件）
                    </h3>
                    {detail.recentReservations.length === 0 ? (
                      <p className="text-xs text-adm-text/50">予約履歴なし</p>
                    ) : (
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="bg-adm-bg">
                            <th className="border border-adm-border px-2 py-1 text-xs text-adm-muted font-bold text-left">日付</th>
                            <th className="border border-adm-border px-2 py-1 text-xs text-adm-muted font-bold text-left">セラピスト</th>
                            <th className="border border-adm-border px-2 py-1 text-xs text-adm-muted font-bold text-left">コース</th>
                            <th className="border border-adm-border px-2 py-1 text-xs text-adm-muted font-bold text-left">状態</th>
                            <th className="border border-adm-border px-2 py-1 text-xs text-adm-muted font-bold text-right">合計</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.recentReservations.map((r) => (
                            <tr key={r.id} className="hover:bg-adm-bg/50">
                              <td className="border border-adm-border px-2 py-1.5 text-xs">
                                {fmtDate(r.dateISO)}
                              </td>
                              <td className="border border-adm-border px-2 py-1.5 text-xs">
                                {r.therapistName}
                              </td>
                              <td className="border border-adm-border px-2 py-1.5 text-xs">
                                {r.courseName}
                              </td>
                              <td className="border border-adm-border px-2 py-1.5 text-xs">
                                {fmtStatus(r.status)}
                              </td>
                              <td className="border border-adm-border px-2 py-1.5 text-xs text-right">
                                ¥{r.total.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* 指名NG */}
                  <div className="bg-adm-surface border border-adm-border rounded-lg p-5">
                    <h3 className="text-xs font-bold text-adm-muted mb-3">指名NG</h3>
                    {detail.ngTherapists.length === 0 ? (
                      <p className="text-xs text-adm-text/50">指名NGなし</p>
                    ) : (
                      <ul className="space-y-1">
                        {detail.ngTherapists.map((ng) => (
                          <li key={ng.therapistId} className="flex items-center gap-2 text-sm">
                            <span className="inline-block w-2 h-2 rounded-full bg-adm-danger flex-shrink-0" />
                            <span className="text-adm-text">{ng.therapistName}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* 引き継ぎメモ */}
                  <div className="bg-adm-surface border border-adm-border rounded-lg p-5">
                    <h3 className="text-xs font-bold text-adm-muted mb-3">引き継ぎメモ</h3>
                    {detail.handoverNotes.length === 0 ? (
                      <p className="text-xs text-adm-text/50">引き継ぎメモなし</p>
                    ) : (
                      <ul className="space-y-3">
                        {detail.handoverNotes.map((n, i) => (
                          <li key={i} className="border-l-2 border-adm-primary/30 pl-3">
                            <p className="text-xs text-adm-muted mb-0.5">
                              {fmtDate(n.createdAtISO)}
                            </p>
                            <p className="text-sm text-adm-text whitespace-pre-wrap">{n.body}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 min-w-0 bg-adm-surface border border-adm-border rounded-lg p-8 flex items-center justify-center">
          <p className="text-sm text-adm-text/50">
            「＋ 新規顧客登録」または一覧から顧客を選んでください
          </p>
        </div>
      )}
    </div>
  );
}
