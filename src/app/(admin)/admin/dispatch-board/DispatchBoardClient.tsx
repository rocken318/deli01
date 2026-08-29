'use client';

/**
 * 配車ボードクライアントコンポーネント（spec 7-1・7-3）。
 *
 * レイアウト:
 *   - 上部: 日付ナビ（前日/翌日ボタン + date input）+ 手動更新 + 退出未記録アラート集約
 *   - ボード本体: 縦軸=時間（30分グリッド）、横軸=セラピスト
 *     各予約は「移動→施術→移動」3ブロック。移動は adm-travel（#B9C2BD）、施術は adm-primary 系。
 *   - 遅延（enroute && 開始時刻超過）: #B4453C（adm-danger）で赤枠
 *   - 退出未記録（in_service/enroute && 終了時刻超過）: 警告アイコン + 上部アラート集約
 *   - 初回訪問: 「初」バッジを施術ブロックに表示
 *   - ステータスワンタップ前進: ボタンで advanceReservationStatus を呼び再取得
 *   - 電話番号: tel: リンク
 */

import { useState, useTransition, useCallback } from 'react';
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
}

const STATUS_LABEL: Record<string, string> = {
  confirmed: '確定',
  enroute: '移動中',
  in_service: '施術中',
  done: '完了',
};

const NEXT_LABEL: Record<string, string> = {
  confirmed: '移動開始',
  enroute: '施術開始',
  in_service: '完了',
};

/** Asia/Tokyo の "HH:mm" 文字列を返す */
function toHHMM(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** ISO 文字列を分単位の数値（0=00:00 基準）に変換する */
function isoToMinutes(isoStr: string): number {
  const d = new Date(isoStr);
  const h = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false });
  const m = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', minute: 'numeric', hour12: false });
  return Number(h) * 60 + Number(m);
}

/** ボードの表示時間範囲: 全予約の最小 depart_at と最大 free_at から決定 */
function calcBoardRange(items: DispatchBoardItem[]): { startMin: number; endMin: number } {
  if (items.length === 0) return { startMin: 8 * 60, endMin: 23 * 60 };
  const starts = items.map((i) => isoToMinutes(i.departAtISO));
  const ends = items.map((i) => isoToMinutes(i.freeAtISO));
  const minStart = Math.min(...starts);
  const maxEnd = Math.max(...ends);
  // 30分単位に切り捨て/切り上げ、前後30分余白
  const startMin = Math.max(0, Math.floor((minStart - 30) / 30) * 30);
  const endMin = Math.min(24 * 60, Math.ceil((maxEnd + 30) / 30) * 30);
  return { startMin, endMin };
}

/** セラピストIDごとにグルーピング、display_order 順（取得順を維持） */
function groupByTherapist(items: DispatchBoardItem[]): { therapistId: string; name: string; items: DispatchBoardItem[] }[] {
  const map = new Map<string, { therapistId: string; name: string; items: DispatchBoardItem[] }>();
  for (const item of items) {
    const existing = map.get(item.therapistId);
    if (existing) {
      existing.items.push(item);
    } else {
      map.set(item.therapistId, { therapistId: item.therapistId, name: item.therapistName, items: [item] });
    }
  }
  return Array.from(map.values());
}

/** 時間ラベル（HH:MM 形式）の行を 30分グリッドで生成 */
function timeLabels(startMin: number, endMin: number): string[] {
  const labels: string[] = [];
  for (let m = startMin; m <= endMin; m += 30) {
    const h = Math.floor(m / 60).toString().padStart(2, '0');
    const min = (m % 60).toString().padStart(2, '0');
    labels.push(`${h}:${min}`);
  }
  return labels;
}

/** 1px = 1分 のスケール。ブロックの top/height を分単位で計算する */
const PX_PER_MIN = 2; // 1分=2px
const COL_WIDTH = 220; // セラピスト列幅px
const LABEL_WIDTH = 56; // 時刻ラベル幅px

/** 前日 / 翌日の ISO 文字列を返す */
function offsetDate(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00+09:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function DispatchBoardClient({ initialItems, initialDate, todayISO }: Props) {
  const [items, setItems] = useState<DispatchBoardItem[]>(initialItems);
  const [date, setDate] = useState<string>(initialDate);
  const [toast, setToast] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  /** now を都度生成（isDelayed / isExitOverdue の判定基準時刻） */
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
      router.push(`/admin/dispatch-board?date=${newDate}`);
      startTransition(async () => {
        const result = await getDispatchBoard(newDate);
        if (result.ok && result.data) {
          setItems(result.data);
        } else {
          setErrorMsg(result.error ?? '取得に失敗しました');
        }
      });
    },
    [router],
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
        // 全件再取得して最新状態を反映
        const refreshed = await getDispatchBoard(date);
        if (refreshed.ok && refreshed.data) {
          setItems(refreshed.data);
        }
      } else {
        setErrorMsg(result.error ?? 'ステータスの更新に失敗しました');
        // 競合・無効遷移の場合も再取得して画面を合わせる
        const refreshed = await getDispatchBoard(date);
        if (refreshed.ok && refreshed.data) {
          setItems(refreshed.data);
        }
      }
    });
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

  // --- 遅延・退出未記録の計算（now を注入）---
  const delayedItems = items.filter((i) =>
    isDelayed({ status: i.status, startAt: new Date(i.startAtISO), now }),
  );
  const overdueItems = items.filter((i) =>
    isExitOverdue({ status: i.status, endAt: new Date(i.endAtISO), now }),
  );

  const { startMin, endMin } = calcBoardRange(items);
  const boardHeightPx = (endMin - startMin) * PX_PER_MIN;
  const labels = timeLabels(startMin, endMin);
  const therapistGroups = groupByTherapist(items);

  return (
    <div>
      {/* トースト */}
      {toast && (
        <div
          className="fixed top-4 right-4 z-50 bg-adm-primary text-white px-4 py-2 text-sm"
          style={{ borderRadius: '4px' }}
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      )}

      {/* エラー */}
      {errorMsg && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm mb-4">
          {errorMsg}
          <button
            onClick={() => setErrorMsg(null)}
            className="ml-2 text-red-600 underline text-xs"
          >
            閉じる
          </button>
        </div>
      )}

      {/* 退出未記録アラート集約（完了条件の主眼 / spec 7-3 L705） */}
      {overdueItems.length > 0 && (
        <div
          className="mb-4 p-3 border text-sm"
          style={{
            backgroundColor: '#FEF2F2',
            borderColor: '#B4453C',
            borderRadius: '4px',
            color: '#B4453C',
          }}
          role="alert"
          aria-live="assertive"
        >
          <div className="font-semibold mb-1">
            ⚠ 退出未記録 {overdueItems.length}件 — 施術終了予定を過ぎても完了記録がありません
          </div>
          <ul className="list-disc list-inside space-y-0.5 text-xs">
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
          className="mb-4 p-3 border text-sm"
          style={{
            backgroundColor: '#FFF7ED',
            borderColor: '#C98A2B',
            borderRadius: '4px',
            color: '#92400E',
          }}
          role="alert"
        >
          <div className="font-semibold mb-1">
            遅延中 {delayedItems.length}件 — 移動中のまま施術開始予定を過ぎています
          </div>
          <ul className="list-disc list-inside space-y-0.5 text-xs">
            {delayedItems.map((i) => (
              <li key={i.reservationId}>
                {i.therapistName} / {i.customerName ?? '顧客不明'} — 開始予定 {toHHMM(i.startAtISO)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 日付ナビ + 更新ボタン */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => changeDate(offsetDate(date, -1))}
          disabled={isPending}
          className="px-3 py-1.5 border border-adm-border text-adm-text text-sm hover:bg-adm-bg disabled:opacity-50 transition-colors"
          style={{ borderRadius: '4px' }}
          aria-label="前日"
        >
          ← 前日
        </button>

        <input
          type="date"
          value={date}
          onChange={(e) => {
            if (e.target.value) changeDate(e.target.value);
          }}
          disabled={isPending}
          className="px-3 py-1.5 border border-adm-border text-adm-text text-sm bg-adm-surface disabled:opacity-50"
          style={{ borderRadius: '4px' }}
          aria-label="日付選択"
        />

        <button
          onClick={() => changeDate(offsetDate(date, 1))}
          disabled={isPending}
          className="px-3 py-1.5 border border-adm-border text-adm-text text-sm hover:bg-adm-bg disabled:opacity-50 transition-colors"
          style={{ borderRadius: '4px' }}
          aria-label="翌日"
        >
          翌日 →
        </button>

        {date !== todayISO && (
          <button
            onClick={() => changeDate(todayISO)}
            disabled={isPending}
            className="px-3 py-1.5 text-sm disabled:opacity-50"
            style={{
              borderRadius: '4px',
              color: '#3F7A6B',
              textDecoration: 'underline',
            }}
          >
            今日に戻る
          </button>
        )}

        <span className="flex-1" />

        <button
          onClick={handleRefresh}
          disabled={isPending}
          className="px-3 py-1.5 border border-adm-border text-adm-text text-sm hover:bg-adm-bg disabled:opacity-50 transition-colors"
          style={{ borderRadius: '4px' }}
        >
          {isPending ? '読込中...' : '更新'}
        </button>
      </div>

      {/* ボード本体 */}
      {items.length === 0 ? (
        /* 空状態 */
        <div
          className="text-sm text-adm-muted py-16 text-center bg-adm-surface border border-adm-border"
          style={{ borderRadius: '4px' }}
        >
          この日の予約はありません
          <br />
          <span className="text-xs">確定済み以降の予約が表示されます</span>
        </div>
      ) : (
        <div
          className="bg-adm-surface border border-adm-border overflow-x-auto"
          style={{ borderRadius: '4px' }}
        >
          {/* ヘッダ行: セラピスト名 */}
          <div
            className="flex border-b border-adm-border sticky top-0 z-10 bg-adm-surface"
            style={{ minWidth: LABEL_WIDTH + therapistGroups.length * COL_WIDTH }}
          >
            {/* 時刻ラベル列のヘッダ */}
            <div
              className="shrink-0 border-r border-adm-border bg-adm-bg"
              style={{ width: LABEL_WIDTH }}
            />
            {/* セラピスト名 */}
            {therapistGroups.map((g) => (
              <div
                key={g.therapistId}
                className="shrink-0 text-center text-sm font-semibold text-adm-text border-r border-adm-border py-2 px-1 truncate"
                style={{ width: COL_WIDTH }}
              >
                {g.name}
              </div>
            ))}
          </div>

          {/* グリッド本体 */}
          <div
            className="flex relative"
            style={{ minWidth: LABEL_WIDTH + therapistGroups.length * COL_WIDTH }}
          >
            {/* 時刻ラベル列 */}
            <div
              className="shrink-0 border-r border-adm-border bg-adm-bg relative"
              style={{ width: LABEL_WIDTH, height: boardHeightPx }}
            >
              {labels.map((label, idx) => (
                <div
                  key={label}
                  className="absolute left-0 right-0 text-xs text-adm-muted px-1 flex items-start"
                  style={{ top: idx * 30 * PX_PER_MIN, height: 30 * PX_PER_MIN }}
                >
                  {label}
                </div>
              ))}
            </div>

            {/* 水平グリッド線（30分ごと）*/}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ left: LABEL_WIDTH }}
            >
              {labels.map((label, idx) => (
                <div
                  key={`grid-${label}`}
                  className="absolute left-0 right-0 border-t border-adm-border"
                  style={{ top: idx * 30 * PX_PER_MIN }}
                />
              ))}
            </div>

            {/* セラピスト列 */}
            {therapistGroups.map((g) => (
              <div
                key={g.therapistId}
                className="shrink-0 relative border-r border-adm-border"
                style={{ width: COL_WIDTH, height: boardHeightPx }}
              >
                {g.items.map((item) => (
                  <ReservationBlocks
                    key={item.reservationId}
                    item={item}
                    startMin={startMin}
                    now={now}
                    isPending={isPending}
                    onAdvance={handleAdvance}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ステータス凡例 */}
      <div className="flex items-center gap-4 mt-4 text-xs text-adm-muted">
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded-sm" style={{ backgroundColor: '#B9C2BD' }} />
          移動
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded-sm" style={{ backgroundColor: '#3F7A6B' }} />
          施術
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded-sm" style={{ backgroundColor: '#B4453C' }} />
          遅延中
        </div>
        <div className="flex items-center gap-1">
          <span
            className="inline-block text-white text-xs font-bold px-1"
            style={{ backgroundColor: '#3F7A6B', borderRadius: '2px' }}
          >
            初
          </span>
          初回訪問
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReservationBlocks: 1予約 = 移動→施術→移動 の3ブロック
// ---------------------------------------------------------------------------

interface BlocksProps {
  item: DispatchBoardItem;
  startMin: number;
  now: Date;
  isPending: boolean;
  onAdvance: (reservationId: string, currentStatus: string) => void;
}

function ReservationBlocks({ item, startMin, now, isPending, onAdvance }: BlocksProps) {
  const delayed = isDelayed({ status: item.status, startAt: new Date(item.startAtISO), now });
  const overdue = isExitOverdue({ status: item.status, endAt: new Date(item.endAtISO), now });

  // 分単位でのオフセット計算
  const departMin = isoToMinutes(item.departAtISO);
  const startAtMin = isoToMinutes(item.startAtISO);
  const endAtMin = isoToMinutes(item.endAtISO);
  const freeMin = isoToMinutes(item.freeAtISO);

  const travelInTop = (departMin - startMin) * PX_PER_MIN;
  const travelInHeight = Math.max((startAtMin - departMin) * PX_PER_MIN, 4);
  const serviceTop = (startAtMin - startMin) * PX_PER_MIN;
  const serviceHeight = Math.max((endAtMin - startAtMin) * PX_PER_MIN, 16);
  const travelOutTop = (endAtMin - startMin) * PX_PER_MIN;
  const travelOutHeight = Math.max((freeMin - endAtMin) * PX_PER_MIN, 4);

  const next = nextAdvanceTarget(item.status);

  // 施術ブロックの背景色: 遅延→赤, 退出未記録→赤, 通常→主色
  const serviceBg = delayed || overdue ? '#B4453C' : '#3F7A6B';
  const serviceTextColor = '#FFFFFF';

  const PADDING = 2; // px, 列内左右パディング

  return (
    <>
      {/* 移動ブロック（出発→到着） */}
      {travelInHeight > 0 && (
        <div
          className="absolute overflow-hidden"
          style={{
            top: travelInTop,
            height: travelInHeight,
            left: PADDING,
            right: PADDING,
            backgroundColor: '#B9C2BD',
            borderRadius: '4px 4px 0 0',
            opacity: item.status === 'done' ? 0.6 : 1,
          }}
          title={`移動中 ${toHHMM(item.departAtISO)}→${toHHMM(item.startAtISO)}（${item.travelInMin}分）`}
        >
          {travelInHeight >= 16 && (
            <span className="text-xs text-adm-text px-1 leading-tight line-clamp-1 block">
              移動 {item.travelInMin}分
            </span>
          )}
        </div>
      )}

      {/* 施術ブロック */}
      <div
        className="absolute overflow-hidden"
        style={{
          top: serviceTop,
          height: serviceHeight,
          left: PADDING,
          right: PADDING,
          backgroundColor: serviceBg,
          borderRadius: 0,
          opacity: item.status === 'done' ? 0.55 : 1,
          border: delayed || overdue ? '2px solid #7B1D1D' : 'none',
        }}
        title={`${item.customerName ?? '顧客不明'} / ${item.courseName} ${toHHMM(item.startAtISO)}→${toHHMM(item.endAtISO)}`}
      >
        <div
          className="h-full px-1 py-0.5 flex flex-col justify-start"
          style={{ color: serviceTextColor }}
        >
          {/* 顧客名 + 初回バッジ */}
          <div className="flex items-center gap-1 text-xs font-semibold leading-tight">
            {item.firstVisit && (
              <span
                className="shrink-0 text-xs font-bold px-1"
                style={{ backgroundColor: '#C98A2B', borderRadius: '2px', fontSize: '10px' }}
              >
                初
              </span>
            )}
            <span className="truncate">{item.customerName ?? '顧客不明'}</span>
          </div>

          {/* エリア・コース時間 */}
          {serviceHeight >= 40 && (
            <div className="text-xs leading-tight opacity-90 truncate mt-0.5">
              {item.areaName ?? item.hotelName ?? ''} {item.courseDurationMin}分
            </div>
          )}

          {/* 電話番号（タップ発信） */}
          {serviceHeight >= 56 && item.customerPhone && (
            <a
              href={`tel:${item.customerPhone}`}
              className="text-xs leading-tight opacity-80 mt-0.5 underline"
              style={{ color: serviceTextColor }}
              onClick={(e) => e.stopPropagation()}
            >
              {item.customerPhone}
            </a>
          )}

          {/* 退出未記録アイコン */}
          {overdue && (
            <span className="text-xs font-bold mt-0.5" title="退出未記録">
              ⚠ 退出未記録
            </span>
          )}

          {/* 遅延アイコン（退出未記録でなく遅延のみの場合） */}
          {delayed && !overdue && (
            <span className="text-xs font-bold mt-0.5" title="遅延中">
              遅延中
            </span>
          )}

          {/* ステータス + 前進ボタン */}
          {serviceHeight >= 72 && (
            <div className="mt-auto pt-1 flex items-center gap-1">
              <span
                className="text-xs px-1 shrink-0"
                style={{ backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: '2px' }}
              >
                {STATUS_LABEL[item.status] ?? item.status}
              </span>
              {next && (
                <button
                  onClick={() => onAdvance(item.reservationId, item.status)}
                  disabled={isPending}
                  className="text-xs px-1.5 py-0.5 font-medium disabled:opacity-40 shrink-0"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.9)',
                    color: serviceBg,
                    borderRadius: '2px',
                  }}
                  title={NEXT_LABEL[item.status] ?? next}
                >
                  {NEXT_LABEL[item.status] ?? next} →
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 施術ブロックが小さすぎてボタンが入らない場合: ブロック下にポップアップカード */}
      {serviceHeight < 72 && (
        <ReservationPopoverTrigger
          item={item}
          next={next}
          serviceBg={serviceBg}
          serviceTop={serviceTop}
          PADDING={PADDING}
          isPending={isPending}
          onAdvance={onAdvance}
          delayed={delayed}
          overdue={overdue}
        />
      )}

      {/* 移動ブロック（退出→フリー） */}
      {travelOutHeight > 0 && (
        <div
          className="absolute overflow-hidden"
          style={{
            top: travelOutTop,
            height: travelOutHeight,
            left: PADDING,
            right: PADDING,
            backgroundColor: '#B9C2BD',
            borderRadius: '0 0 4px 4px',
            opacity: item.status === 'done' ? 0.6 : 1,
          }}
          title={`撤収 ${toHHMM(item.endAtISO)}→${toHHMM(item.freeAtISO)}（${item.travelOutMin}分）`}
        >
          {travelOutHeight >= 16 && (
            <span className="text-xs text-adm-text px-1 leading-tight block">
              撤収 {item.travelOutMin}分
            </span>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 施術ブロックが小さい場合の詳細カード（hover/focus で表示）
// ---------------------------------------------------------------------------

interface PopoverProps {
  item: DispatchBoardItem;
  next: AdvanceTarget | null;
  serviceBg: string;
  serviceTop: number;
  PADDING: number;
  isPending: boolean;
  onAdvance: (reservationId: string, currentStatus: string) => void;
  delayed: boolean;
  overdue: boolean;
}

function ReservationPopoverTrigger({
  item,
  next,
  serviceBg,
  serviceTop,
  PADDING,
  isPending,
  onAdvance,
  delayed,
  overdue,
}: PopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="absolute"
      style={{
        // 施術ブロックの右端の外にポップアップを出す
        top: serviceTop,
        left: PADDING,
        right: PADDING,
        pointerEvents: 'none',
      }}
    >
      {/* トリガ: 施術ブロック上でクリック */}
      <button
        className="absolute inset-0 opacity-0"
        style={{ pointerEvents: 'auto' }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${item.customerName ?? '顧客不明'} の詳細`}
      />

      {/* ポップアップ本体 */}
      {open && (
        <>
          {/* オーバーレイ（外クリックで閉じる） */}
          <div
            className="fixed inset-0 z-10"
            style={{ pointerEvents: 'auto' }}
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute z-20 p-3 shadow-md text-white text-sm"
            style={{
              pointerEvents: 'auto',
              left: COL_WIDTH - PADDING * 2 + 4,
              top: 0,
              width: 200,
              backgroundColor: serviceBg,
              borderRadius: '4px',
              border: delayed || overdue ? '2px solid #7B1D1D' : 'none',
            }}
          >
            <div className="flex items-center gap-1 font-semibold mb-1">
              {item.firstVisit && (
                <span
                  className="text-xs font-bold px-1"
                  style={{ backgroundColor: '#C98A2B', borderRadius: '2px', fontSize: '10px' }}
                >
                  初
                </span>
              )}
              {item.customerName ?? '顧客不明'}
            </div>
            <div className="text-xs opacity-90 mb-1">
              {item.areaName ?? item.hotelName ?? ''} / {item.courseName} {item.courseDurationMin}分
            </div>
            <div className="text-xs opacity-90 mb-1">
              {toHHMM(item.startAtISO)} → {toHHMM(item.endAtISO)}
            </div>
            {item.customerPhone && (
              <a
                href={`tel:${item.customerPhone}`}
                className="text-xs underline opacity-80 block mb-2"
                style={{ color: '#FFFFFF' }}
              >
                {item.customerPhone}
              </a>
            )}
            {overdue && (
              <div className="text-xs font-bold mb-1">⚠ 退出未記録</div>
            )}
            {delayed && !overdue && (
              <div className="text-xs font-bold mb-1">遅延中</div>
            )}
            <div className="flex items-center gap-1 mt-1">
              <span
                className="text-xs px-1"
                style={{ backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: '2px' }}
              >
                {STATUS_LABEL[item.status] ?? item.status}
              </span>
              {next && (
                <button
                  onClick={() => {
                    onAdvance(item.reservationId, item.status);
                    setOpen(false);
                  }}
                  disabled={isPending}
                  className="text-xs px-1.5 py-0.5 font-medium disabled:opacity-40"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.9)',
                    color: serviceBg,
                    borderRadius: '2px',
                  }}
                >
                  {NEXT_LABEL[item.status] ?? next} →
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
