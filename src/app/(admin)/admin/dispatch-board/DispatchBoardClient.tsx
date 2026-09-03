'use client';

/**
 * 配車ボードクライアントコンポーネント（spec 7-1・7-3 / 改修: 1行=1配車の表）。
 *
 * レイアウト:
 *   - 上部: 遅延/退出未記録アラート集約
 *   - 日付ナビ（前日/翌日ボタン + date input）+ 手動更新
 *   - 表本体: 1行=1配車。列 = 女性／コース(分)／派遣先(エリア+ホテル)／部屋／出発／IN／ドライバー／OUT／メモ
 *   - ドライバー(dispatch_driver)・メモ(dispatch_memo) はインライン編集
 *   - ステータス前進ボタン（各行）で advanceReservationStatus を呼ぶ
 *   - 遅延行: adm-danger（#B4453C）背景。退出未記録行: adm-warning（#C98A2B）背景
 *
 * 住所・電話番号の扱い:
 *   - 電話番号は表に出さない（住所ゲートは queries の可視制御が守る / spec 7-3）
 *   - アドレス情報は area_name / hotel_name / address_label のみ表示
 *
 * props 互換:
 *   - initialItems / initialDate / todayISO / syncUrl は既存のまま維持
 *     （/admin/annai の ConsoleTabs 埋め込みが syncUrl=false で使っている）
 */

import { useState, useTransition, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { DispatchBoardItem, AdvanceTarget } from '@/lib/dispatch-board/queries';
import {
  nextStatus,
  isDelayed,
  isExitOverdue,
} from '@/domain/dispatch-board';
import {
  advanceReservationStatus,
  getDispatchBoard,
  updateDispatchFields,
} from '@/lib/dispatch-board/actions';

/** nextStatus は DispatchStatus | null を返すが confirmed は進め先にならない */
function nextAdvanceTarget(status: string): AdvanceTarget | null {
  const n = nextStatus(status);
  if (n === null || n === 'confirmed') return null;
  return n;
}

interface Props {
  initialItems: DispatchBoardItem[];
  initialDate: string;
  todayISO: string;
  /**
   * 日付変更時に URL（/admin/dispatch-board?date=）へ push するか。
   * 単体ページでは true（deep-link 可）。案内表の時系列タブに埋め込むときは false
   * にして、埋め込み元 URL から離脱せずローカル state のみ更新する（判断 Q2）。
   */
  syncUrl?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  confirmed: '確定',
  enroute: '移動中',
  in_service: '施術中',
  done: '完了',
};

const NEXT_LABEL: Record<string, string> = {
  confirmed: '移動開始',
  enroute: 'IN',
  in_service: 'OUT',
};

/** Asia/Tokyo の "HH:mm" 文字列を返す */
function toHHMM(isoStr: string | null | undefined): string {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 前日 / 翌日の ISO 文字列を返す */
function offsetDate(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00+09:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 派遣先表示: エリア + ホテル名 or 住所ラベル */
function formatDestination(item: DispatchBoardItem): string {
  const parts: string[] = [];
  if (item.areaName) parts.push(item.areaName);
  if (item.hotelName) parts.push(item.hotelName);
  else if (item.addressLabel) parts.push(item.addressLabel);
  return parts.join(' ') || '—';
}

/** コース表示: コース名 + 分数 */
function formatCourse(item: DispatchBoardItem): string {
  return `${item.courseName} ${item.courseDurationMin}分`;
}

// ---------------------------------------------------------------------------
// インライン編集セル（driver / memo 共通）
// ---------------------------------------------------------------------------

interface InlineEditCellProps {
  value: string | null;
  placeholder: string;
  onSave: (val: string) => Promise<void>;
  disabled: boolean;
}

function InlineEditCell({ value, placeholder, onSave, disabled }: InlineEditCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (disabled || saving) return;
    setDraft(value ?? '');
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    }
    if (e.key === 'Escape') {
      setEditing(false);
      setDraft(value ?? '');
    }
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0 }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { void handleSave(); }}
          onKeyDown={handleKeyDown}
          disabled={saving}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            padding: '2px 6px',
            border: '1px solid #3F7A6B',
            borderRadius: 4,
            background: '#fff',
            color: '#1C2321',
          }}
          aria-label={placeholder}
        />
        {saving && (
          <span style={{ fontSize: 11, color: '#6B7776' }}>保存中…</span>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={`クリックして編集: ${placeholder}`}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderBottom: value ? 'none' : '1px dashed #B9C2BD',
        padding: '2px 0',
        fontSize: 12,
        color: value ? '#1C2321' : '#9BA5AF',
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {value || placeholder}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 行コンポーネント
// ---------------------------------------------------------------------------

interface RowProps {
  item: DispatchBoardItem;
  now: Date;
  isPending: boolean;
  onAdvance: (reservationId: string, currentStatus: string) => void;
  onFieldSaved: (reservationId: string, field: 'driver' | 'memo', value: string) => void;
}

function DispatchRow({ item, now, isPending, onAdvance, onFieldSaved }: RowProps) {
  const delayed = isDelayed({ status: item.status, startAt: new Date(item.startAtISO), now });
  const overdue = isExitOverdue({ status: item.status, endAt: new Date(item.endAtISO), now });
  const next = nextAdvanceTarget(item.status);

  // 行背景色
  let rowBg = 'transparent';
  if (overdue) rowBg = '#FEF0EE'; // 薄赤（退出未記録）
  else if (delayed) rowBg = '#FFF8EC'; // 薄橙（遅延）

  const handleSaveDriver = async (val: string) => {
    const result = await updateDispatchFields(item.reservationId, { driver: val });
    if (result.ok) onFieldSaved(item.reservationId, 'driver', val);
  };

  const handleSaveMemo = async (val: string) => {
    const result = await updateDispatchFields(item.reservationId, { memo: val });
    if (result.ok) onFieldSaved(item.reservationId, 'memo', val);
  };

  // 出発時刻: enroute_at（実出発）を優先、なければ depart_at（予定出発）
  const departDisplay = item.enrouteAtISO ? toHHMM(item.enrouteAtISO) : toHHMM(item.departAtISO);
  const departLabel = item.enrouteAtISO ? departDisplay : `(${departDisplay})`;

  const TD_STYLE: React.CSSProperties = {
    padding: '6px 8px',
    borderBottom: '1px solid #DFE3DE',
    borderRight: '1px solid #DFE3DE',
    fontSize: 12,
    color: '#1C2321',
    verticalAlign: 'middle',
    background: rowBg,
    whiteSpace: 'nowrap',
  };

  return (
    <tr>
      {/* 女性（セラピスト名）*/}
      <td style={{ ...TD_STYLE, fontWeight: 600, color: '#3F7A6B' }}>
        {item.therapistName}
        {item.firstVisit && (
          <span
            style={{
              display: 'inline-block',
              marginLeft: 4,
              fontSize: 10,
              fontWeight: 700,
              padding: '0 4px',
              background: '#C98A2B',
              color: '#fff',
              borderRadius: 2,
            }}
          >
            初
          </span>
        )}
      </td>

      {/* コース（分・延長込み）*/}
      <td style={TD_STYLE}>
        <div>{formatCourse(item)}</div>
        <div style={{ fontSize: 11, color: '#6B7776' }}>{item.customerName ?? '顧客未設定'}</div>
      </td>

      {/* 派遣先（エリア・ホテル名 or ラベル）*/}
      <td style={{ ...TD_STYLE, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {formatDestination(item)}
      </td>

      {/* 部屋（addressLabel）*/}
      <td style={{ ...TD_STYLE, maxWidth: 80 }}>
        {item.addressLabel ?? '—'}
      </td>

      {/* 出発（enroute_at 実、なければ depart_at 予定）*/}
      <td style={{ ...TD_STYLE, fontFamily: "'IBM Plex Mono', monospace", textAlign: 'center' }}>
        {departLabel}
      </td>

      {/* IN（arrived_at）*/}
      <td style={{ ...TD_STYLE, fontFamily: "'IBM Plex Mono', monospace", textAlign: 'center' }}>
        {item.arrivedAtISO ? (
          toHHMM(item.arrivedAtISO)
        ) : (
          <span style={{ color: '#B9C2BD' }}>—</span>
        )}
      </td>

      {/* ドライバー（インライン編集）*/}
      <td style={{ ...TD_STYLE, minWidth: 90 }}>
        <InlineEditCell
          value={item.dispatchDriver}
          placeholder="ドライバー"
          onSave={handleSaveDriver}
          disabled={isPending}
        />
      </td>

      {/* OUT（done_at）*/}
      <td style={{ ...TD_STYLE, fontFamily: "'IBM Plex Mono', monospace", textAlign: 'center' }}>
        {item.doneAtISO ? (
          toHHMM(item.doneAtISO)
        ) : (
          <span style={{ color: '#B9C2BD' }}>—</span>
        )}
      </td>

      {/* メモ（インライン編集）*/}
      <td style={{ ...TD_STYLE, minWidth: 100 }}>
        <InlineEditCell
          value={item.dispatchMemo}
          placeholder="メモ"
          onSave={handleSaveMemo}
          disabled={isPending}
        />
      </td>

      {/* ステータス + 前進ボタン */}
      <td style={{ ...TD_STYLE, whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap' }}>
          {/* ステータスバッジ */}
          <span
            style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 2,
              fontWeight: 600,
              background: delayed || overdue ? '#B4453C' : item.status === 'done' ? '#E7E9E7' : '#EAF3EF',
              color: delayed || overdue ? '#fff' : item.status === 'done' ? '#5b625f' : '#2c6152',
            }}
          >
            {STATUS_LABEL[item.status] ?? item.status}
            {delayed && ' 遅延'}
            {overdue && !delayed && ' 要確認'}
          </span>

          {/* 前進ボタン */}
          {next && (
            <button
              type="button"
              onClick={() => onAdvance(item.reservationId, item.status)}
              disabled={isPending}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 2,
                border: '1px solid #3F7A6B',
                background: '#3F7A6B',
                color: '#fff',
                fontWeight: 600,
                cursor: isPending ? 'not-allowed' : 'pointer',
                opacity: isPending ? 0.5 : 1,
                whiteSpace: 'nowrap',
              }}
              aria-label={`${item.therapistName}: ${NEXT_LABEL[item.status] ?? next}`}
            >
              {NEXT_LABEL[item.status] ?? next} →
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

export default function DispatchBoardClient({
  initialItems,
  initialDate,
  todayISO,
  syncUrl = true,
}: Props) {
  const [items, setItems] = useState<DispatchBoardItem[]>(initialItems);
  const [date, setDate] = useState<string>(initialDate);
  const [toast, setToast] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const now = new Date();

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  /** 日付変更 → URL更新 + 再取得 */
  const changeDate = useCallback(
    (newDate: string) => {
      setDate(newDate);
      setErrorMsg(null);
      if (syncUrl) router.push(`/admin/dispatch-board?date=${newDate}`);
      startTransition(async () => {
        const result = await getDispatchBoard(newDate);
        if (result.ok && result.data) {
          setItems(result.data);
        } else {
          setErrorMsg(result.error ?? '取得に失敗しました');
        }
      });
    },
    [router, syncUrl],
  );

  /** ステータス前進 */
  const handleAdvance = (reservationId: string, currentStatus: string) => {
    const next = nextAdvanceTarget(currentStatus);
    if (!next) return;
    setErrorMsg(null);
    startTransition(async () => {
      const result = await advanceReservationStatus(reservationId, next);
      if (result.ok) {
        showToast(`ステータスを「${STATUS_LABEL[next] ?? next}」に更新しました`);
      } else {
        setErrorMsg(result.error ?? 'ステータスの更新に失敗しました');
      }
      // 成功/失敗問わず全件再取得（競合・無効遷移でも画面を合わせる）
      const refreshed = await getDispatchBoard(date);
      if (refreshed.ok && refreshed.data) {
        setItems(refreshed.data);
      }
    });
  };

  /** インライン編集後のローカル state 更新（サーバ再取得なしで即反映） */
  const handleFieldSaved = (
    reservationId: string,
    field: 'driver' | 'memo',
    value: string,
  ) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.reservationId !== reservationId) return item;
        return {
          ...item,
          dispatchDriver: field === 'driver' ? value : item.dispatchDriver,
          dispatchMemo: field === 'memo' ? value : item.dispatchMemo,
        };
      }),
    );
  };

  /** 手動更新 */
  const handleRefresh = () => {
    setErrorMsg(null);
    startTransition(async () => {
      const result = await getDispatchBoard(date);
      if (result.ok && result.data) {
        setItems(result.data);
        showToast('更新しました');
      } else {
        setErrorMsg(result.error ?? '更新に失敗しました');
      }
    });
  };

  // 遅延・退出未記録の集計
  const delayedItems = items.filter((i) =>
    isDelayed({ status: i.status, startAt: new Date(i.startAtISO), now }),
  );
  const overdueItems = items.filter((i) =>
    isExitOverdue({ status: i.status, endAt: new Date(i.endAtISO), now }),
  );

  // 開始時刻昇順ソート（queries は start_at asc で返るが念のため）
  const sorted = [...items].sort(
    (a, b) => new Date(a.startAtISO).getTime() - new Date(b.startAtISO).getTime(),
  );

  // テーブルヘッダ共通スタイル
  const TH_STYLE: React.CSSProperties = {
    padding: '6px 8px',
    borderBottom: '2px solid #DFE3DE',
    borderRight: '1px solid #DFE3DE',
    fontSize: 11,
    fontWeight: 700,
    color: '#6B7776',
    background: '#F6F7F5',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  };

  return (
    <div>
      {/* トースト */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 50,
            background: '#3F7A6B',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {toast}
        </div>
      )}

      {/* エラー */}
      {errorMsg && (
        <div
          style={{
            background: '#FEF2F2',
            border: '1px solid #B4453C',
            color: '#B4453C',
            borderRadius: 4,
            padding: '10px 14px',
            fontSize: 13,
            marginBottom: 12,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            style={{ fontSize: 12, color: '#B4453C', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            閉じる
          </button>
        </div>
      )}

      {/* 退出未記録アラート集約 */}
      {overdueItems.length > 0 && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            background: '#FEF2F2',
            border: '1px solid #B4453C',
            borderRadius: 4,
            padding: '10px 14px',
            marginBottom: 10,
            color: '#B4453C',
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            退出未記録 {overdueItems.length}件 — 施術終了予定を過ぎても完了記録がありません
          </div>
          <ul style={{ margin: 0, padding: '0 0 0 18px', fontSize: 12 }}>
            {overdueItems.map((i) => (
              <li key={i.reservationId}>
                {i.therapistName} / {i.customerName ?? '顧客不明'} — 終了予定 {toHHMM(i.endAtISO)}
                （現状: {STATUS_LABEL[i.status] ?? i.status}）
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 遅延アラート集約 */}
      {delayedItems.length > 0 && (
        <div
          role="alert"
          style={{
            background: '#FFF8EC',
            border: '1px solid #C98A2B',
            borderRadius: 4,
            padding: '10px 14px',
            marginBottom: 10,
            color: '#8a5d16',
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            遅延中 {delayedItems.length}件 — 移動中のまま施術開始予定を過ぎています
          </div>
          <ul style={{ margin: 0, padding: '0 0 0 18px', fontSize: 12 }}>
            {delayedItems.map((i) => (
              <li key={i.reservationId}>
                {i.therapistName} / {i.customerName ?? '顧客不明'} — 開始予定 {toHHMM(i.startAtISO)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 日付ナビ + 更新ボタン */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => changeDate(offsetDate(date, -1))}
          disabled={isPending}
          style={{
            padding: '5px 12px',
            border: '1px solid #DFE3DE',
            borderRadius: 4,
            background: '#fff',
            color: '#1C2321',
            fontSize: 13,
            cursor: isPending ? 'not-allowed' : 'pointer',
            opacity: isPending ? 0.5 : 1,
          }}
          aria-label="前日"
        >
          ← 前日
        </button>

        <input
          type="date"
          value={date}
          onChange={(e) => { if (e.target.value) changeDate(e.target.value); }}
          disabled={isPending}
          style={{
            padding: '5px 10px',
            border: '1px solid #DFE3DE',
            borderRadius: 4,
            background: '#fff',
            color: '#1C2321',
            fontSize: 13,
          }}
          aria-label="日付選択"
        />

        <button
          type="button"
          onClick={() => changeDate(offsetDate(date, 1))}
          disabled={isPending}
          style={{
            padding: '5px 12px',
            border: '1px solid #DFE3DE',
            borderRadius: 4,
            background: '#fff',
            color: '#1C2321',
            fontSize: 13,
            cursor: isPending ? 'not-allowed' : 'pointer',
            opacity: isPending ? 0.5 : 1,
          }}
          aria-label="翌日"
        >
          翌日 →
        </button>

        <button
          type="button"
          onClick={() => changeDate(todayISO)}
          disabled={isPending || date === todayISO}
          aria-pressed={date === todayISO}
          aria-label="当日（今日）に移動"
          style={{
            padding: '5px 12px',
            border: '1px solid #3F7A6B',
            borderRadius: 4,
            background: date === todayISO ? '#EAF3EF' : 'transparent',
            color: '#3F7A6B',
            fontWeight: 600,
            fontSize: 13,
            cursor: isPending || date === todayISO ? 'default' : 'pointer',
            opacity: isPending || date === todayISO ? 0.5 : 1,
          }}
        >
          当日
        </button>

        <div style={{ flex: 1 }} />

        <button
          type="button"
          onClick={handleRefresh}
          disabled={isPending}
          style={{
            padding: '5px 12px',
            border: '1px solid #DFE3DE',
            borderRadius: 4,
            background: '#fff',
            color: '#1C2321',
            fontSize: 13,
            cursor: isPending ? 'not-allowed' : 'pointer',
            opacity: isPending ? 0.5 : 1,
          }}
        >
          {isPending ? '読込中…' : '更新'}
        </button>
      </div>

      {/* ローディング状態 */}
      {isPending && (
        <div
          style={{
            textAlign: 'center',
            padding: '12px 0',
            fontSize: 13,
            color: '#6B7776',
          }}
          aria-live="polite"
        >
          読込中…
        </div>
      )}

      {/* ボード本体 */}
      {!isPending && sorted.length === 0 ? (
        /* 空状態 */
        <div
          style={{
            textAlign: 'center',
            padding: '48px 0',
            fontSize: 13,
            color: '#9BA5AF',
            background: '#fff',
            border: '1px solid #DFE3DE',
            borderRadius: 4,
          }}
        >
          この日の予約はありません
          <br />
          <span style={{ fontSize: 11, color: '#B9C2BD' }}>確定済み以降の予約が表示されます</span>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              background: '#fff',
              border: '1px solid #DFE3DE',
              borderRadius: 4,
              minWidth: 900,
            }}
          >
            <thead>
              <tr>
                <th style={TH_STYLE}>女性</th>
                <th style={TH_STYLE}>コース（分）</th>
                <th style={TH_STYLE}>派遣先</th>
                <th style={TH_STYLE}>部屋</th>
                <th style={{ ...TH_STYLE, textAlign: 'center' }}>出発</th>
                <th style={{ ...TH_STYLE, textAlign: 'center' }}>IN</th>
                <th style={TH_STYLE}>ドライバー</th>
                <th style={{ ...TH_STYLE, textAlign: 'center' }}>OUT</th>
                <th style={TH_STYLE}>メモ</th>
                <th style={TH_STYLE}>ステータス</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((item) => (
                <DispatchRow
                  key={item.reservationId}
                  item={item}
                  now={now}
                  isPending={isPending}
                  onAdvance={handleAdvance}
                  onFieldSaved={handleFieldSaved}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 凡例 */}
      <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 11, color: '#9BA5AF' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 12, height: 12, borderRadius: 2, background: '#FEF2F2', border: '1px solid #B4453C' }} />
          退出未記録
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 12, height: 12, borderRadius: 2, background: '#FFF8EC', border: '1px solid #C98A2B' }} />
          遅延中
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontWeight: 700, color: '#C98A2B' }}>初</span>
          初回訪問
        </div>
        <div style={{ color: '#B9C2BD' }}>
          出発の ( ) は予定時刻。実出発後は括弧なしの実測値に切り替わります。
        </div>
      </div>
    </div>
  );
}
