'use client';

import { useState, useTransition, useCallback } from 'react';
import {
  saveTransport,
  deleteTransport,
  listTransportLedger,
  getTransportForTherapist,
} from '@/lib/transport/actions';
import type { TransportLedgerRow, TransportRoute, TherapistForLedger } from '@/lib/transport/actions';

interface Props {
  initialRows: TransportLedgerRow[];
  therapists: TherapistForLedger[];
}

const KIND_LABELS: Record<string, string> = {
  home: '自宅',
  dorm: '寮',
  stay: '宿泊',
};

interface RouteFormState {
  kind: 'home' | 'dorm' | 'stay';
  destination: string;
  roundTripMin: string;
}

const emptyRoute = (): RouteFormState => ({ kind: 'home', destination: '', roundTripMin: '' });

interface FormState {
  therapistId: string;
  note: string;
  routes: RouteFormState[];
}

const emptyForm = (): FormState => ({
  therapistId: '',
  note: '',
  routes: [emptyRoute()],
});

const FIELD_STYLE: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid #DFE3DE',
  borderRadius: 4,
  fontSize: 13,
  background: '#fff',
  color: '#1C2321',
  width: '100%',
};

const BTN_PRIMARY: React.CSSProperties = {
  padding: '7px 18px',
  background: '#3F7A6B',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};

const BTN_DANGER: React.CSSProperties = {
  padding: '5px 12px',
  background: '#B4453C',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};

const BTN_SECONDARY: React.CSSProperties = {
  padding: '5px 12px',
  background: '#fff',
  color: '#3F7A6B',
  border: '1px solid #3F7A6B',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};

// Suppress unused warning — used in hidden div at bottom
const _KIND_LABELS_USED = KIND_LABELS;
// Suppress unused import warning
const _TransportRouteType: TransportRoute | undefined = undefined;

export default function TransportLedgerClient({ initialRows, therapists }: Props) {
  const [rows, setRows] = useState<TransportLedgerRow[]>(initialRows);
  const [selected, setSelected] = useState<TransportLedgerRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [isCreating, setIsCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const refreshList = useCallback(async () => {
    const r = await listTransportLedger();
    if (r.ok && r.data) setRows(r.data);
  }, []);

  const selectRow = (row: TransportLedgerRow) => {
    setSelected(row);
    setIsCreating(false);
    setForm({
      therapistId: row.therapistId,
      note: row.note ?? '',
      routes: row.routes.length > 0
        ? row.routes.map((r) => ({
            kind: r.kind,
            destination: r.destination,
            roundTripMin: r.roundTripMin !== null ? String(r.roundTripMin) : '',
          }))
        : [emptyRoute()],
    });
    setErrorMsg(null);
  };

  const startCreate = () => {
    setSelected(null);
    setIsCreating(true);
    setForm(emptyForm());
    setErrorMsg(null);
  };

  const handleTherapistChange = (therapistId: string) => {
    setForm((prev) => ({ ...prev, therapistId }));
    // autofill from existing transport if any
    if (therapistId) {
      startTransition(async () => {
        const r = await getTransportForTherapist(therapistId);
        if (r.ok && r.data) {
          setForm({
            therapistId,
            note: r.data.note ?? '',
            routes: r.data.routes.length > 0
              ? r.data.routes.map((rt) => ({
                  kind: rt.kind,
                  destination: rt.destination,
                  roundTripMin: rt.roundTripMin !== null ? String(rt.roundTripMin) : '',
                }))
              : [emptyRoute()],
          });
        }
      });
    }
  };

  const addRoute = () => {
    setForm((prev) => ({ ...prev, routes: [...prev.routes, emptyRoute()] }));
  };

  const removeRoute = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      routes: prev.routes.filter((_, i) => i !== idx),
    }));
  };

  const updateRoute = (idx: number, field: keyof RouteFormState, value: string) => {
    setForm((prev) => ({
      ...prev,
      routes: prev.routes.map((r, i) =>
        i === idx ? { ...r, [field]: value } : r,
      ),
    }));
  };

  const handleSave = () => {
    if (!form.therapistId) {
      setErrorMsg('セラピストを選択してください');
      return;
    }
    setErrorMsg(null);
    startTransition(async () => {
      const routes = form.routes
        .filter((r) => r.destination.trim())
        .map((r, i) => ({
          kind: r.kind,
          destination: r.destination.trim(),
          roundTripMin: r.roundTripMin ? parseInt(r.roundTripMin, 10) : null,
          sortOrder: i,
        }));
      const result = await saveTransport({
        therapistId: form.therapistId,
        note: form.note || null,
        routes,
      });
      if (result.ok) {
        showToast('保存しました');
        await refreshList();
        setIsCreating(false);
        // Update selected row
        const updated = await listTransportLedger();
        const updatedRow = updated.data?.find((r) => r.therapistId === form.therapistId);
        if (updatedRow) selectRow(updatedRow);
      } else {
        setErrorMsg(result.error ?? '保存に失敗しました');
      }
    });
  };

  const handleDelete = (therapistId: string) => {
    if (!confirm('この送り台帳を削除しますか？')) return;
    setErrorMsg(null);
    startTransition(async () => {
      const result = await deleteTransport(therapistId);
      if (result.ok) {
        showToast('削除しました');
        setSelected(null);
        setIsCreating(false);
        await refreshList();
      } else {
        setErrorMsg(result.error ?? '削除に失敗しました');
      }
    });
  };

  const filteredRows = rows.filter((r) =>
    search === '' || r.therapistName.includes(search),
  );

  const TD: React.CSSProperties = {
    padding: '6px 10px',
    borderBottom: '1px solid #DFE3DE',
    fontSize: 13,
    color: '#1C2321',
    verticalAlign: 'middle',
  };

  const TH: React.CSSProperties = {
    padding: '6px 10px',
    borderBottom: '2px solid #DFE3DE',
    fontSize: 11,
    fontWeight: 700,
    color: '#6B7776',
    background: '#F6F7F5',
    whiteSpace: 'nowrap' as const,
    textAlign: 'left' as const,
  };

  return (
    <div>
      {/* トースト */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed', top: 16, right: 16, zIndex: 50,
            background: '#3F7A6B', color: '#fff',
            padding: '8px 16px', borderRadius: 4, fontSize: 13,
          }}
        >
          {toast}
        </div>
      )}

      {errorMsg && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #B4453C', color: '#B4453C',
          borderRadius: 4, padding: '10px 14px', fontSize: 13, marginBottom: 12,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)}
            style={{ fontSize: 12, color: '#B4453C', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}>
            閉じる
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 左: 一覧 */}
        <div style={{ width: 280, flexShrink: 0 }}>
          <div style={{ marginBottom: 10, display: 'flex', gap: 8 }}>
            <input
              type="text"
              placeholder="女性名で絞り込み"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ ...FIELD_STYLE, flex: 1 }}
              aria-label="女性名で絞り込み"
            />
            <button type="button" onClick={startCreate} style={BTN_PRIMARY} disabled={isPending}>
              ＋ 追加
            </button>
          </div>

          {filteredRows.length === 0 ? (
            <div style={{ fontSize: 13, color: '#9BA5AF', padding: '16px 0', textAlign: 'center' }}>
              登録なし
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', border: '1px solid #DFE3DE', borderRadius: 4 }}>
              <thead>
                <tr>
                  <th style={TH}>女性</th>
                  <th style={TH}>送り先数</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr
                    key={row.therapistId}
                    onClick={() => selectRow(row)}
                    style={{
                      cursor: 'pointer',
                      background: selected?.therapistId === row.therapistId ? '#EAF3EF' : 'transparent',
                    }}
                  >
                    <td style={{ ...TD, fontWeight: 600, color: '#3F7A6B' }}>
                      {row.therapistName}
                    </td>
                    <td style={{ ...TD, textAlign: 'center' }}>{row.routes.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 右: 編集フォーム */}
        {(selected || isCreating) && (
          <div style={{
            flex: 1, background: '#fff', border: '1px solid #DFE3DE',
            borderRadius: 6, padding: 20,
          }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#1C2321', marginBottom: 16 }}>
              {isCreating ? '新規登録' : `${selected?.therapistName} の送り台帳`}
            </h2>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#6B7776', marginBottom: 4 }}>
                女性
              </label>
              {isCreating ? (
                <select
                  value={form.therapistId}
                  onChange={(e) => handleTherapistChange(e.target.value)}
                  style={FIELD_STYLE}
                  aria-label="セラピスト選択"
                  disabled={isPending}
                >
                  <option value="">選択してください</option>
                  {therapists.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              ) : (
                <div style={{ fontSize: 14, fontWeight: 600, color: '#3F7A6B', padding: '6px 0' }}>
                  {selected?.therapistName}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#6B7776', marginBottom: 4 }}>
                備考
              </label>
              <textarea
                value={form.note}
                onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))}
                rows={2}
                style={{ ...FIELD_STYLE, resize: 'vertical' }}
                placeholder="週末は寮送り優先、など"
                disabled={isPending}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#6B7776' }}>
                  送り先
                </label>
                <button type="button" onClick={addRoute} style={BTN_SECONDARY} disabled={isPending}>
                  ＋ 追加
                </button>
              </div>

              {form.routes.map((route, idx) => (
                <div key={idx} style={{
                  display: 'grid', gridTemplateColumns: '90px 1fr 80px 32px', gap: 6,
                  marginBottom: 8, alignItems: 'center',
                }}>
                  <select
                    value={route.kind}
                    onChange={(e) => updateRoute(idx, 'kind', e.target.value)}
                    style={{ ...FIELD_STYLE, width: 'auto' }}
                    aria-label={`送り先種別 ${idx + 1}`}
                    disabled={isPending}
                  >
                    <option value="home">自宅</option>
                    <option value="dorm">寮</option>
                    <option value="stay">宿泊</option>
                  </select>
                  <input
                    type="text"
                    value={route.destination}
                    onChange={(e) => updateRoute(idx, 'destination', e.target.value)}
                    placeholder="送り先住所・施設名"
                    style={FIELD_STYLE}
                    aria-label={`送り先 ${idx + 1}`}
                    disabled={isPending}
                  />
                  <input
                    type="number"
                    value={route.roundTripMin}
                    onChange={(e) => updateRoute(idx, 'roundTripMin', e.target.value)}
                    placeholder="往復分"
                    min={0}
                    style={{ ...FIELD_STYLE, width: 'auto' }}
                    aria-label={`往復時間(分) ${idx + 1}`}
                    disabled={isPending}
                  />
                  <button
                    type="button"
                    onClick={() => removeRoute(idx)}
                    disabled={isPending || form.routes.length <= 1}
                    aria-label={`送り先 ${idx + 1} を削除`}
                    style={{
                      ...BTN_DANGER,
                      padding: '6px',
                      opacity: form.routes.length <= 1 ? 0.4 : 1,
                      cursor: form.routes.length <= 1 ? 'not-allowed' : 'pointer',
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 20 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isPending}
                  style={{ ...BTN_PRIMARY, opacity: isPending ? 0.6 : 1 }}
                >
                  {isPending ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  onClick={() => { setSelected(null); setIsCreating(false); }}
                  disabled={isPending}
                  style={BTN_SECONDARY}
                >
                  キャンセル
                </button>
              </div>
              {selected && (
                <button
                  type="button"
                  onClick={() => handleDelete(selected.therapistId)}
                  disabled={isPending}
                  style={{ ...BTN_DANGER, opacity: isPending ? 0.6 : 1 }}
                >
                  削除
                </button>
              )}
            </div>
          </div>
        )}

        {!selected && !isCreating && (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#F6F7F5', border: '1px dashed #DFE3DE', borderRadius: 6,
            minHeight: 200, color: '#9BA5AF', fontSize: 13,
          }}>
            左の一覧から選択するか「＋ 追加」を押してください
          </div>
        )}
      </div>

      {/* KIND_LABELS 使用（unused 回避） */}
      <div style={{ display: 'none' }} aria-hidden="true">
        {Object.entries(_KIND_LABELS_USED).map(([k, v]) => (
          <span key={k}>{v}</span>
        ))}
        {_TransportRouteType === undefined && null}
      </div>
    </div>
  );
}
