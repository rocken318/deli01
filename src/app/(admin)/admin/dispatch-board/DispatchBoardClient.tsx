'use client';

/**
 * 配車ボードクライアントコンポーネント（フェーズ4 再設計 / 設計 4.6・4.7・5.1）。
 *
 * レイアウト（モック board-redesign-v6.html 準拠。退勤送りセクションはフェーズ6）:
 *   - 上部: 遅延/退出未記録アラート集約（既存踏襲）
 *   - 日付ナビ（前日/翌日/当日 + date input）+ 「終了分も表示」トグル + 手動更新
 *   - 表本体: 1行=1予約。列 = 女性/コース(分)/派遣先/部屋/出発/IN/送り車/OUT/帰り車/メモ/状態・終了
 *   - 送り車/帰り車セル: 割当ドライバー表示・セル全面を状態色で塗る・左に車色帯・
 *     状態プルダウン（送り=6状態/帰り=4状態）→ setLegState。未割当は点線ドロップゾーン
 *   - ドラッグ&ドロップ: 右レールのドライバーチップを脚セルへドロップ → assignLegDriver（上書き）
 *   - LINE 2ボタン（🚕運転手/👩女性）はプレースホルダ（フェーズ9 で実装。今はトースト「準備中」）
 *   - 終了ボタン: 送り/帰りの全脚が「完了」の時のみ活性 → finishReservation → 一覧から消える
 *   - 右レール: 本日出勤ドライバー（listActiveDriversForDate / フェーズ3）
 *
 * 住所・電話番号の扱い:
 *   - 電話番号は表に出さない（住所ゲートは queries の可視制御が守る / spec 7-3）
 *   - アドレス情報は area_name / hotel_name / address_label のみ表示
 *
 * props 互換:
 *   - initialItems / initialDate / todayISO / syncUrl は既存のまま維持
 *     （/admin/annai の ConsoleTabs 埋め込みが syncUrl=false で使っている）
 *   - initialLegs / initialActiveDrivers は省略可（省略時はマウント時に取得）
 */

import { useState, useTransition, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { DispatchBoardItem, AdvanceTarget } from '@/lib/dispatch-board/queries';
import {
  nextStatus,
  isDelayed,
  isExitOverdue,
} from '@/domain/dispatch-board';
import Link from 'next/link';
import {
  advanceReservationStatus,
  getDispatchBoard,
  updateDispatchFields,
} from '@/lib/dispatch-board/actions';
import { setReservationDispatchNeeds } from '@/lib/dispatch-board/needs-actions';
import {
  assignLegDriver,
  setLegState,
  clearLegDriver,
  finishReservation,
  getDispatchLegs,
} from '@/lib/dispatch-board/leg-actions';
import type { LegView, ReservationLegs } from '@/lib/dispatch-board/leg-actions';
import { listActiveDriversForDate } from '@/lib/drivers/shift-actions';
import type { ActiveDriver } from '@/lib/drivers/shift-actions';
import {
  SEND_STATES,
  RETURN_STATES,
  type LegSlot,
} from '@/domain/dispatch/leg-states';

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
  /** 当日の配車脚（includeFinished=true で取得したもの）。省略時はマウント時に取得 */
  initialLegs?: ReservationLegs[];
  /** 本日出勤ドライバー（右レール）。省略時はマウント時に取得 */
  initialActiveDrivers?: ActiveDriver[];
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

/** 脚状態 → セル配色（モック v6 の s-* クラス準拠） */
const STATE_COLORS: Record<string, { bg: string; fg: string }> = {
  予定: { bg: '#E2EAF2', fg: '#2f4a6b' },
  送り中: { bg: '#BFE0D1', fg: '#184c3b' },
  合流確認中: { bg: '#F3C9C1', fg: '#7d2a22' },
  インコール待機中: { bg: '#E7EAE7', fg: '#454b48' },
  バック中: { bg: '#DFD0EF', fg: '#4c356f' },
  完了: { bg: '#D3DDD7', fg: '#3f5249' },
  向かい中: { bg: '#BFE0D1', fg: '#184c3b' },
  アウト待ち: { bg: '#F4DDB4', fg: '#6f4e12' },
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

/** ドライバーの車表示（車番 + 色名） */
function formatVehicle(number: string | null, colorName: string | null): string {
  return [number, colorName].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// インライン編集セル（memo）
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
// 送り車/帰り車 脚セル
// ---------------------------------------------------------------------------

interface LegCellProps {
  slot: LegSlot;
  leg: LegView | null;
  disabled: boolean;
  onDropDriver: (driverId: string) => void;
  onChangeState: (legId: string, state: string) => void;
  onClearDriver: (legId: string) => void;
  onLinePlaceholder: () => void;
}

function LegCell({
  slot, leg, disabled, onDropDriver, onChangeState, onClearDriver, onLinePlaceholder,
}: LegCellProps) {
  const [isOver, setIsOver] = useState(false);
  const states = slot === 'send' ? SEND_STATES : RETURN_STATES;
  const slotLabel = slot === 'send' ? '送り車' : '帰り車';
  const lineLabel = slot === 'send' ? '送りLINE' : '帰りLINE';

  const handleDragOver = (e: React.DragEvent<HTMLTableCellElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isOver) setIsOver(true);
  };

  const handleDrop = (e: React.DragEvent<HTMLTableCellElement>) => {
    e.preventDefault();
    setIsOver(false);
    const driverId = e.dataTransfer.getData('text/plain');
    if (driverId && !disabled) onDropDriver(driverId);
  };

  const colors = leg ? (STATE_COLORS[leg.state] ?? { bg: '#fff', fg: '#1C2321' }) : null;

  if (!leg || !leg.driverId) {
    // 未割当（脚なし or 割当解除済み）: 点線ドロップゾーン
    return (
      <td
        onDragOver={handleDragOver}
        onDragLeave={() => setIsOver(false)}
        onDrop={handleDrop}
        style={{
          padding: 4,
          borderBottom: '1px solid #DFE3DE',
          borderRight: '1px solid #DFE3DE',
          verticalAlign: 'middle',
          minWidth: 130,
        }}
      >
        <div
          style={{
            border: `1px dashed ${isOver ? '#3F7A6B' : '#c3cac6'}`,
            borderRadius: 6,
            color: isOver ? '#3F7A6B' : '#aeb6b2',
            textAlign: 'center',
            padding: '10px 4px',
            fontSize: 11,
            background: isOver
              ? '#EAF3EF'
              : 'repeating-linear-gradient(45deg,#fafbfa,#fafbfa 6px,#f4f6f4 6px,#f4f6f4 12px)',
          }}
        >
          {slotLabel}をドラッグ
        </div>
      </td>
    );
  }

  return (
    <td
      onDragOver={handleDragOver}
      onDragLeave={() => setIsOver(false)}
      onDrop={handleDrop}
      style={{
        padding: '6px 8px',
        borderBottom: '1px solid #DFE3DE',
        borderRight: '1px solid #DFE3DE',
        borderLeft: `5px solid ${leg.vehicleColorHex ?? '#ccc'}`,
        verticalAlign: 'top',
        minWidth: 130,
        background: colors!.bg,
        color: colors!.fg,
        outline: isOver ? '2px dashed #3F7A6B' : 'none',
        outlineOffset: -2,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontWeight: 700, fontSize: 12 }}>{leg.driverName ?? '—'}</span>
        <span style={{ fontSize: 10, color: '#5f6b66' }}>
          {formatVehicle(leg.vehicleNumber, leg.vehicleColorName)}
        </span>
        <button
          type="button"
          onClick={() => onClearDriver(leg.id)}
          disabled={disabled}
          title={`${slotLabel}の割当を解除`}
          aria-label={`${slotLabel}の割当を解除`}
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            lineHeight: 1,
            padding: '2px 4px',
            border: '1px solid rgba(0,0,0,.15)',
            borderRadius: 3,
            background: 'rgba(255,255,255,.7)',
            color: '#5f6b66',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          ✕
        </button>
      </div>
      <select
        value={leg.state}
        onChange={(e) => onChangeState(leg.id, e.target.value)}
        disabled={disabled}
        aria-label={`${slotLabel}の状態`}
        style={{
          marginTop: 5,
          fontSize: 11,
          fontWeight: 800,
          padding: '3px 4px',
          borderRadius: 5,
          width: '100%',
          border: '1px solid rgba(0,0,0,.15)',
          background: 'rgba(255,255,255,.65)',
          color: 'inherit',
        }}
      >
        {states.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <div style={{ marginTop: 5, display: 'flex', gap: 4, alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: '#5f6b66', width: 38 }}>{lineLabel}</span>
        <button
          type="button"
          onClick={onLinePlaceholder}
          title="LINE送信はフェーズ9で実装予定"
          style={{
            fontSize: 10,
            border: '1px solid rgba(0,0,0,.15)',
            background: 'rgba(255,255,255,.85)',
            borderRadius: 4,
            padding: '1px 6px',
            cursor: 'pointer',
            color: '#333',
          }}
        >
          🚕運転手
        </button>
        <button
          type="button"
          onClick={onLinePlaceholder}
          title="LINE送信はフェーズ9で実装予定"
          style={{
            fontSize: 10,
            border: '1px solid rgba(0,0,0,.15)',
            background: 'rgba(255,255,255,.85)',
            borderRadius: 4,
            padding: '1px 6px',
            cursor: 'pointer',
            color: '#333',
          }}
        >
          👩女性
        </button>
      </div>
    </td>
  );
}

// ---------------------------------------------------------------------------
// 行コンポーネント
// ---------------------------------------------------------------------------

interface RowProps {
  item: DispatchBoardItem;
  legs: ReservationLegs | null;
  now: Date;
  isPending: boolean;
  onAdvance: (reservationId: string, currentStatus: string) => void;
  onMemoSaved: (reservationId: string, value: string) => void;
  onAssignDriver: (reservationId: string, slot: LegSlot, driverId: string) => void;
  onChangeLegState: (legId: string, slot: LegSlot, state: string) => void;
  onClearLegDriver: (legId: string) => void;
  onFinish: (reservationId: string) => void;
  onLinePlaceholder: () => void;
  onToggleDispatch: (reservationId: string, needsSendCar: boolean, needsReturnCar: boolean) => void;
}

function DispatchRow({
  item, legs, now, isPending,
  onAdvance, onMemoSaved, onAssignDriver, onChangeLegState, onClearLegDriver,
  onFinish, onLinePlaceholder, onToggleDispatch,
}: RowProps) {
  const delayed = isDelayed({ status: item.status, startAt: new Date(item.startAtISO), now });
  const overdue = isExitOverdue({ status: item.status, endAt: new Date(item.endAtISO), now });
  const next = nextAdvanceTarget(item.status);

  const sendLeg = legs?.send ?? null;
  const returnLeg = legs?.return ?? null;
  const legList = [sendLeg, returnLeg].filter((l): l is LegView => l !== null);
  const allLegsDone = legList.length > 0 && legList.every((l) => l.state === '完了');
  const finished = legs?.allFinished ?? false;

  // 行背景色
  let rowBg = 'transparent';
  if (overdue) rowBg = '#FEF0EE'; // 薄赤（退出未記録）
  else if (delayed) rowBg = '#FFF8EC'; // 薄橙（遅延）

  const handleSaveMemo = async (val: string) => {
    const result = await updateDispatchFields(item.reservationId, { memo: val });
    if (result.ok) onMemoSaved(item.reservationId, val);
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
    <tr style={finished ? { opacity: 0.5 } : undefined}>
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

      {/* 部屋（room_number 優先、旧データは addressLabel フォールバック）*/}
      <td style={{ ...TD_STYLE, maxWidth: 80 }}>
        {item.roomNumber ?? item.addressLabel ?? '—'}
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

      {/* 送り車（脚セル）: needsSendCar=false のとき「—」 */}
      {item.needsSendCar ? (
        <LegCell
          slot="send"
          leg={sendLeg}
          disabled={isPending}
          onDropDriver={(driverId) => onAssignDriver(item.reservationId, 'send', driverId)}
          onChangeState={(legId, state) => onChangeLegState(legId, 'send', state)}
          onClearDriver={onClearLegDriver}
          onLinePlaceholder={onLinePlaceholder}
        />
      ) : (
        <td style={{ ...TD_STYLE, minWidth: 130, color: '#B9C2BD', textAlign: 'center' }}>—</td>
      )}

      {/* OUT（done_at）*/}
      <td style={{ ...TD_STYLE, fontFamily: "'IBM Plex Mono', monospace", textAlign: 'center' }}>
        {item.doneAtISO ? (
          toHHMM(item.doneAtISO)
        ) : (
          <span style={{ color: '#B9C2BD' }}>—</span>
        )}
      </td>

      {/* 帰り車（脚セル）: needsReturnCar=false のとき「—」 */}
      {item.needsReturnCar ? (
        <LegCell
          slot="return"
          leg={returnLeg}
          disabled={isPending}
          onDropDriver={(driverId) => onAssignDriver(item.reservationId, 'return', driverId)}
          onChangeState={(legId, state) => onChangeLegState(legId, 'return', state)}
          onClearDriver={onClearLegDriver}
          onLinePlaceholder={onLinePlaceholder}
        />
      ) : (
        <td style={{ ...TD_STYLE, minWidth: 130, color: '#B9C2BD', textAlign: 'center' }}>—</td>
      )}

      {/* メモ（インライン編集）*/}
      <td style={{ ...TD_STYLE, minWidth: 100 }}>
        <InlineEditCell
          value={item.dispatchMemo}
          placeholder="メモ"
          onSave={handleSaveMemo}
          disabled={isPending}
        />
      </td>

      {/* 配車トグル（送り/帰り。送りON→帰りも自動ON） */}
      <td style={{ ...TD_STYLE, whiteSpace: 'nowrap', minWidth: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: isPending ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox"
              checked={item.needsSendCar}
              disabled={isPending}
              onChange={(e) => {
                const send = e.target.checked;
                // 送りON → 帰りも自動ON
                const ret = send ? true : item.needsReturnCar;
                onToggleDispatch(item.reservationId, send, ret);
              }}
            />
            送り
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: isPending ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox"
              checked={item.needsReturnCar}
              disabled={isPending}
              onChange={(e) => {
                const ret = e.target.checked;
                onToggleDispatch(item.reservationId, item.needsSendCar, ret);
              }}
            />
            帰り
          </label>
        </div>
      </td>

      {/* ステータス + 前進ボタン + 終了ボタン */}
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

        {/* 終了ボタン（全脚「完了」で活性 → 一覧から消す）*/}
        {finished ? (
          <span
            style={{
              display: 'inline-block',
              marginTop: 6,
              fontSize: 11,
              padding: '1px 7px',
              borderRadius: 10,
              fontWeight: 600,
              background: '#E7F3EC',
              color: '#1f7a54',
            }}
          >
            終了済み
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onFinish(item.reservationId)}
            disabled={isPending || !allLegsDone}
            title={allLegsDone ? '終了して一覧から消す' : '送り車・帰り車がすべて「完了」になると押せます'}
            style={{
              marginTop: 6,
              display: 'block',
              width: '100%',
              fontSize: 11,
              fontWeight: 800,
              padding: '3px 6px',
              borderRadius: 6,
              border: allLegsDone ? '1px solid #3F7A6B' : '1px solid #d7dbd7',
              background: allLegsDone ? '#3F7A6B' : '#F3F4F3',
              color: allLegsDone ? '#fff' : '#aab2ae',
              cursor: isPending || !allLegsDone ? 'not-allowed' : 'pointer',
            }}
          >
            終了
          </button>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// 右レール: 本日出勤ドライバー
// ---------------------------------------------------------------------------

function DriverRail({ drivers }: { drivers: ActiveDriver[] }) {
  return (
    <div
      style={{
        width: 180,
        flexShrink: 0,
        background: '#fff',
        border: '1px solid #DFE3DE',
        borderRadius: 8,
        padding: 10,
      }}
    >
      <h2
        style={{
          fontSize: 12,
          margin: '0 0 8px',
          color: '#6B7776',
          fontWeight: 700,
        }}
      >
        本日出勤ドライバー
      </h2>
      {drivers.length === 0 ? (
        <div style={{ fontSize: 11, color: '#9BA5AF', padding: '8px 0' }}>
          出勤ドライバーがいません
          <br />
          <Link
            href="/admin/drivers"
            style={{ color: '#3F7A6B', textDecoration: 'underline' }}
          >
            シフト登録へ
          </Link>
        </div>
      ) : (
        drivers.map((d) => (
          <div
            key={d.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', d.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            title={`${d.name} をドラッグして送り車/帰り車セルへ`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 8px',
              border: '1px solid #DFE3DE',
              borderLeft: `4px solid ${d.vehicleColorHex ?? '#ccc'}`,
              borderRadius: 6,
              marginBottom: 7,
              background: '#fff',
              cursor: 'grab',
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#1C2321' }}>{d.name}</div>
              <div style={{ fontSize: 11, color: '#6B7776' }}>
                {formatVehicle(d.vehicleNumber, d.vehicleColorName) || '車両未設定'}
              </div>
              <div style={{ fontSize: 10, color: '#9BA5AF', fontFamily: "'IBM Plex Mono', monospace" }}>
                {d.start}–{d.end}
              </div>
            </div>
            <span style={{ marginLeft: 'auto', color: '#c3cac6', fontSize: 14 }} aria-hidden>
              ⋮⋮
            </span>
          </div>
        ))
      )}
    </div>
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
  initialLegs,
  initialActiveDrivers,
}: Props) {
  const [items, setItems] = useState<DispatchBoardItem[]>(initialItems);
  const [legs, setLegs] = useState<ReservationLegs[]>(initialLegs ?? []);
  const [drivers, setDrivers] = useState<ActiveDriver[]>(initialActiveDrivers ?? []);
  const [date, setDate] = useState<string>(initialDate);
  const [showFinished, setShowFinished] = useState(false);
  const [showNoDispatch, setShowNoDispatch] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const now = new Date();

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  /** 脚のみ再取得（常に includeFinished=true で取り、表示はクライアントで絞る） */
  const refreshLegs = useCallback(async (targetDate: string) => {
    const result = await getDispatchLegs(targetDate, true);
    if (result.ok && result.data) {
      setLegs(result.data);
      return true;
    }
    setErrorMsg(result.error ?? '配車脚の取得に失敗しました');
    return false;
  }, []);

  /** ボード・脚・右レールをまとめて再取得 */
  const refreshAll = useCallback(async (targetDate: string) => {
    const [board, legsResult, driversResult] = await Promise.all([
      getDispatchBoard(targetDate),
      getDispatchLegs(targetDate, true),
      listActiveDriversForDate(targetDate),
    ]);
    if (board.ok && board.data) {
      setItems(board.data);
    } else {
      setErrorMsg(board.error ?? '取得に失敗しました');
    }
    if (legsResult.ok && legsResult.data) setLegs(legsResult.data);
    if (driversResult.ok && driversResult.data) setDrivers(driversResult.data);
    return board.ok;
  }, []);

  // 埋め込み利用（annai）で initialLegs / initialActiveDrivers が渡されないときはマウント時に取得
  useEffect(() => {
    if (initialLegs === undefined || initialActiveDrivers === undefined) {
      startTransition(async () => {
        const [legsResult, driversResult] = await Promise.all([
          getDispatchLegs(initialDate, true),
          listActiveDriversForDate(initialDate),
        ]);
        if (legsResult.ok && legsResult.data) setLegs(legsResult.data);
        if (driversResult.ok && driversResult.data) setDrivers(driversResult.data);
      });
    }
    // マウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 日付変更 → URL更新 + 再取得（ボード + 脚 + 右レール） */
  const changeDate = useCallback(
    (newDate: string) => {
      setDate(newDate);
      setErrorMsg(null);
      if (syncUrl) router.push(`/admin/dispatch-board?date=${newDate}`);
      startTransition(async () => {
        await refreshAll(newDate);
      });
    },
    [router, syncUrl, refreshAll],
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

  /** メモ編集後のローカル state 更新（サーバ再取得なしで即反映） */
  const handleMemoSaved = (reservationId: string, value: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.reservationId === reservationId ? { ...item, dispatchMemo: value } : item,
      ),
    );
  };

  /** D&D: 脚へドライバー割当（上書き） */
  const handleAssignDriver = (reservationId: string, slot: LegSlot, driverId: string) => {
    setErrorMsg(null);
    startTransition(async () => {
      const result = await assignLegDriver({ reservationId, slot, driverId });
      if (result.ok) {
        showToast(slot === 'send' ? '送り車を割り当てました' : '帰り車を割り当てました');
      } else {
        setErrorMsg(result.error ?? 'ドライバー割当に失敗しました');
      }
      await refreshLegs(date);
    });
  };

  /** 脚の状態変更（プルダウン） */
  const handleChangeLegState = (legId: string, slot: LegSlot, state: string) => {
    setErrorMsg(null);
    // 楽観更新（プルダウンの見た目を即時反映）
    setLegs((prev) =>
      prev.map((r) => ({
        ...r,
        send: r.send?.id === legId ? { ...r.send, state } : r.send,
        return: r.return?.id === legId ? { ...r.return, state } : r.return,
      })),
    );
    startTransition(async () => {
      const result = await setLegState({ legId, slot, state });
      if (!result.ok) {
        setErrorMsg(result.error ?? '状態の更新に失敗しました');
      }
      await refreshLegs(date);
    });
  };

  /** 脚の割当解除 */
  const handleClearLegDriver = (legId: string) => {
    setErrorMsg(null);
    startTransition(async () => {
      const result = await clearLegDriver({ legId });
      if (result.ok) {
        showToast('割当を解除しました');
      } else {
        setErrorMsg(result.error ?? '割当解除に失敗しました');
      }
      await refreshLegs(date);
    });
  };

  /** 終了（全脚完了時のみ）→ 一覧から消える */
  const handleFinish = (reservationId: string) => {
    setErrorMsg(null);
    startTransition(async () => {
      const result = await finishReservation({ reservationId });
      if (result.ok) {
        showToast('終了しました（「終了分も表示」で確認できます）');
      } else {
        setErrorMsg(result.error ?? '終了処理に失敗しました');
      }
      await refreshLegs(date);
    });
  };

  /** LINE 送信プレースホルダ（フェーズ9 で実装） */
  const handleLinePlaceholder = () => {
    showToast('LINE送信は準備中です（フェーズ9で実装予定）');
  };

  /** 配車トグル（送り/帰りフラグ更新）→ ローカル state を楽観更新後にサーバ反映 */
  const handleToggleDispatch = (reservationId: string, needsSendCar: boolean, needsReturnCar: boolean) => {
    // 楽観更新
    setItems((prev) =>
      prev.map((item) =>
        item.reservationId === reservationId
          ? { ...item, needsSendCar, needsReturnCar }
          : item,
      ),
    );
    setErrorMsg(null);
    startTransition(async () => {
      const result = await setReservationDispatchNeeds({ reservationId, needsSendCar, needsReturnCar });
      if (!result.ok) {
        setErrorMsg(result.error ?? '配車フラグの更新に失敗しました');
        // ロールバック: 再取得
        const refreshed = await getDispatchBoard(date);
        if (refreshed.ok && refreshed.data) setItems(refreshed.data);
      }
    });
  };

  /** 手動更新 */
  const handleRefresh = () => {
    setErrorMsg(null);
    startTransition(async () => {
      const ok = await refreshAll(date);
      if (ok) showToast('更新しました');
    });
  };

  // reservationId → 脚 のマップ
  const legsByRes = new Map<string, ReservationLegs>(legs.map((l) => [l.reservationId, l]));

  // 終了分の表示制御: allFinished の予約はトグル OFF なら隠す
  // 配車不要フィルタ: showNoDispatch=false の場合、配車不要（両方false）の行は隠す
  const visibleItems = items.filter((i) => {
    if (!showFinished && (legsByRes.get(i.reservationId)?.allFinished ?? false)) return false;
    if (!showNoDispatch && !i.needsSendCar && !i.needsReturnCar) return false;
    return true;
  });

  // 遅延・退出未記録の集計（表示中の行が対象）
  const delayedItems = visibleItems.filter((i) =>
    isDelayed({ status: i.status, startAt: new Date(i.startAtISO), now }),
  );
  const overdueItems = visibleItems.filter((i) =>
    isExitOverdue({ status: i.status, endAt: new Date(i.endAtISO), now }),
  );

  // 開始時刻昇順ソート（queries は start_at asc で返るが念のため）
  const sorted = [...visibleItems].sort(
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

      {/* 日付ナビ + 終了分トグル + 更新ボタン */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
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

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: '#6B7776',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={showFinished}
            onChange={(e) => setShowFinished(e.target.checked)}
            disabled={isPending}
          />
          終了分も表示
        </label>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: '#6B7776',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={showNoDispatch}
            onChange={(e) => setShowNoDispatch(e.target.checked)}
            disabled={isPending}
          />
          配車不要も表示
        </label>

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
        <Link
          href="/admin/dispatch-roster"
          className="text-sm text-adm-primary underline underline-offset-2"
        >
          配車名簿
        </Link>
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

      {/* ボード本体 + 右レール */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
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
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                background: '#fff',
                border: '1px solid #DFE3DE',
                borderRadius: 4,
                minWidth: 1120,
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
                  <th style={TH_STYLE}>送り車</th>
                  <th style={{ ...TH_STYLE, textAlign: 'center' }}>OUT</th>
                  <th style={TH_STYLE}>帰り車</th>
                  <th style={TH_STYLE}>メモ</th>
                  <th style={TH_STYLE}>配車</th>
                  <th style={TH_STYLE}>状態 / 終了</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((item) => (
                  <DispatchRow
                    key={item.reservationId}
                    item={item}
                    legs={legsByRes.get(item.reservationId) ?? null}
                    now={now}
                    isPending={isPending}
                    onAdvance={handleAdvance}
                    onMemoSaved={handleMemoSaved}
                    onAssignDriver={handleAssignDriver}
                    onChangeLegState={handleChangeLegState}
                    onClearLegDriver={handleClearLegDriver}
                    onFinish={handleFinish}
                    onLinePlaceholder={handleLinePlaceholder}
                    onToggleDispatch={handleToggleDispatch}
                  />
                ))}
              </tbody>
            </table>
          )}

          {/* 凡例 */}
          <div style={{ display: 'flex', gap: 10, marginTop: 10, fontSize: 11, color: '#9BA5AF', flexWrap: 'wrap', alignItems: 'center' }}>
            <span>送り:</span>
            {SEND_STATES.map((s) => (
              <span
                key={`send-${s}`}
                style={{
                  fontWeight: 800,
                  borderRadius: 5,
                  padding: '2px 8px',
                  background: STATE_COLORS[s]?.bg,
                  color: STATE_COLORS[s]?.fg,
                }}
              >
                {s}
              </span>
            ))}
            <span style={{ marginLeft: 10 }}>帰り:</span>
            {RETURN_STATES.map((s) => (
              <span
                key={`return-${s}`}
                style={{
                  fontWeight: 800,
                  borderRadius: 5,
                  padding: '2px 8px',
                  background: STATE_COLORS[s]?.bg,
                  color: STATE_COLORS[s]?.fg,
                }}
              >
                {s}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: '#9BA5AF' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 12, height: 12, borderRadius: 2, background: '#FEF0EE', border: '1px solid #B4453C' }} />
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

        {/* 右レール: 本日出勤ドライバー */}
        <DriverRail drivers={drivers} />
      </div>
    </div>
  );
}
