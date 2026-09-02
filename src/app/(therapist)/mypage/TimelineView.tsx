'use client';

/**
 * 当日タイムラインビュー（spec 7-4）。
 *
 * - 次の出発時刻（最初の未完了の departAtISO）を最上部に大きく表示
 * - 移動→施術→移動の3ブロック構造（時刻帯を色分け）
 * - ワンタップでステータス前進（set-once: 完了後はボタン非表示）
 * - isExitOverdue: 警告（赤帯）
 * - 住所は 180分ゲート内のみ表示（addressDetail が null = ゲート外 = 表示しない）
 * - 電話番号: TherapistTimelineItem 型に存在しないため表示不可（型レベルで安全）
 */

import { useState, useTransition } from 'react';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { nextStatus, canTransition } from '@/domain/dispatch-board';
import type { DispatchStatus } from '@/domain/dispatch-board';
import { advanceMyReservationStatus } from '@/lib/dispatch-board/therapist-portal-actions';
import type { TherapistTimelineItem, AdvanceTarget } from '@/lib/dispatch-board/queries';
import HandoverSection from './HandoverSection';

const APP_TZ = 'Asia/Tokyo';

function fmtTime(isoStr: string): string {
  return format(toZonedTime(new Date(isoStr), APP_TZ), 'HH:mm');
}

const ADVANCE_LABEL: Partial<Record<DispatchStatus, string>> = {
  enroute: '移動開始',
  in_service: '到着・施術開始',
  done: '完了',
};

interface Props {
  initialItems: TherapistTimelineItem[];
  asSlug?: string;
  /**
   * 表示中の日付が「今日」か。過去/未来の履歴閲覧では false にして、
   * ステータス前進ボタンと「次の出発時刻」を出さない（読み取り専用の履歴）。
   * 省略時は true（従来どおり当日運用）。
   */
  isToday?: boolean;
}

interface ItemState {
  status: string;
  version: number;
  error?: string;
}

export default function TimelineView({ initialItems, asSlug, isToday = true }: Props) {
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>(() => {
    const s: Record<string, ItemState> = {};
    for (const item of initialItems) {
      s[item.reservationId] = { status: item.status, version: item.version };
    }
    return s;
  });
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  // 次の出発時刻 = 最初の未完了（done 以外）予約の depart_at
  const nextItem = initialItems.find(
    (item) =>
      (itemStates[item.reservationId]?.status ?? item.status) !== 'done',
  );

  function handleAdvance(reservationId: string, currentStatus: string) {
    const to = nextStatus(currentStatus as DispatchStatus);
    // 'confirmed' は AdvanceTarget に含まれない（遷移先が enroute 以降のみ有効）
    if (!to || to === 'confirmed') return;
    const advanceTo: AdvanceTarget = to;
    setPendingId(reservationId);
    startTransition(async () => {
      const result = await advanceMyReservationStatus(reservationId, advanceTo, asSlug);
      if (result.ok && result.data) {
        setItemStates((prev) => ({
          ...prev,
          [reservationId]: {
            status: to,
            version: result.data!.version,
            error: undefined,
          },
        }));
      } else {
        setItemStates((prev) => ({
          ...prev,
          [reservationId]: {
            ...(prev[reservationId] ?? { status: currentStatus, version: 0 }),
            error: result.error ?? '更新に失敗しました',
          },
        }));
      }
      setPendingId(null);
    });
  }

  if (initialItems.length === 0) {
    return (
      <div
        className="rounded p-6 text-center text-sm"
        style={{
          background: '#FFFFFF',
          border: '1px solid #DFE3DE',
          color: '#6B7776',
          borderRadius: '4px',
        }}
      >
        {isToday ? '本日の予定はありません' : '予定はありません'}
      </div>
    );
  }

  return (
    <div>
      {/* 次の出発時刻（最上部・大きく）。当日のみ＝過去/未来の履歴では出さない */}
      {isToday && nextItem && (
        <div
          className="rounded p-4 mb-4 text-center"
          style={{
            background: '#FFFFFF',
            border: '1px solid #DFE3DE',
            borderRadius: '4px',
          }}
        >
          <p className="text-xs mb-1" style={{ color: '#6B7776' }}>
            次の出発時刻
          </p>
          <p
            className="font-bold tabular-nums"
            style={{ fontSize: '3rem', color: '#3F7A6B', lineHeight: 1.1 }}
          >
            {fmtTime(nextItem.departAtISO)}
          </p>
          <p className="text-sm mt-1" style={{ color: '#1C2321' }}>
            {nextItem.areaName ?? '—'} / {nextItem.courseName}
          </p>
        </div>
      )}

      {/* タイムラインリスト */}
      <ol className="space-y-3" aria-label="予約タイムライン">
        {initialItems.map((item) => {
          const state = itemStates[item.reservationId] ?? {
            status: item.status,
            version: item.version,
          };
          const currentStatus = state.status as DispatchStatus;
          const toSt = nextStatus(currentStatus);
          const canAdv = toSt ? canTransition(currentStatus, toSt) : false;
          const isThisPending = isPending && pendingId === item.reservationId;
          const isDone = currentStatus === 'done';

          return (
            <li
              key={item.reservationId}
              className="rounded"
              style={{
                background: '#FFFFFF',
                border: item.exitOverdue
                  ? '2px solid #B4453C'
                  : '1px solid #DFE3DE',
                borderRadius: '4px',
                overflow: 'hidden',
              }}
            >
              {/* 退出未記録アラート */}
              {item.exitOverdue && (
                <div
                  className="px-4 py-2 text-sm font-semibold"
                  style={{ background: '#B4453C', color: '#FFFFFF' }}
                  role="alert"
                >
                  退出未記録: 早めに完了ボタンを押してください
                </div>
              )}

              {/* ヘッダ: 時刻・エリア・コース */}
              <div className="px-4 pt-3 pb-2">
                {/* 3ブロック: 移動|施術|移動 の時刻ライン */}
                <div
                  className="flex items-center gap-1 text-xs mb-2 flex-wrap"
                  aria-label="タイムスロット"
                >
                  <span
                    className="px-2 py-0.5"
                    style={{
                      background: '#B9C2BD',
                      color: '#1C2321',
                      borderRadius: '4px',
                    }}
                  >
                    {fmtTime(item.departAtISO)} 出発
                  </span>
                  <span style={{ color: '#6B7776' }}>→</span>
                  <span
                    className="px-2 py-0.5 font-medium"
                    style={{
                      background: '#3F7A6B',
                      color: '#FFFFFF',
                      borderRadius: '4px',
                    }}
                  >
                    {fmtTime(item.startAtISO)}〜{fmtTime(item.endAtISO)}
                  </span>
                  <span style={{ color: '#6B7776' }}>→</span>
                  <span
                    className="px-2 py-0.5"
                    style={{
                      background: '#B9C2BD',
                      color: '#1C2321',
                      borderRadius: '4px',
                    }}
                  >
                    {fmtTime(item.freeAtISO)} 帰着
                  </span>
                </div>

                {/* エリア・ホテル・コース */}
                <p className="font-semibold text-sm" style={{ color: '#1C2321' }}>
                  {item.areaName ?? '—'}
                  {item.hotelName ? ` / ${item.hotelName}` : ''}
                </p>
                <p className="text-sm mt-0.5" style={{ color: '#6B7776' }}>
                  {item.courseName}（{item.courseDurationMin}分）
                </p>

                {/* 住所（180分ゲート内のみ） */}
                {item.addressDetail && (
                  <p
                    className="text-sm mt-2 p-2"
                    style={{
                      background: '#F6F7F5',
                      color: '#1C2321',
                      borderRadius: '4px',
                      border: '1px solid #DFE3DE',
                    }}
                  >
                    {item.addressLabel ? `${item.addressLabel}: ` : ''}
                    {item.addressDetail}
                  </p>
                )}

                {/* 顧客メモ */}
                {item.customerNote && (
                  <p className="text-xs mt-1" style={{ color: '#6B7776' }}>
                    メモ: {item.customerNote}
                  </p>
                )}

                {/* ステータスバッジ + 遅延 */}
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <StatusBadge status={currentStatus} />
                  {item.delayed && (
                    <span
                      className="text-xs px-2 py-0.5 font-semibold"
                      style={{
                        background: '#C98A2B',
                        color: '#FFFFFF',
                        borderRadius: '4px',
                      }}
                    >
                      遅延
                    </span>
                  )}
                </div>
              </div>

              {/* エラー表示 */}
              {state.error && (
                <div
                  className="mx-4 mb-2 text-xs p-2"
                  style={{
                    background: '#fff0f0',
                    color: '#B4453C',
                    borderRadius: '4px',
                    border: '1px solid #B4453C',
                  }}
                >
                  {state.error}
                </div>
              )}

              {/* 引き継ぎメモ（フェーズ16 / spec 9章 L810-814） */}
              <HandoverSection
                reservationId={item.reservationId}
                status={currentStatus}
                asSlug={asSlug}
              />

              {/* ワンタップ前進ボタン（当日のみ。過去/未来の履歴では出さない） */}
              {isToday && !isDone && canAdv && toSt && (
                <div className="px-4 pb-3">
                  <button
                    type="button"
                    onClick={() => handleAdvance(item.reservationId, currentStatus)}
                    disabled={isThisPending || isPending}
                    className="w-full py-3 rounded font-semibold text-white disabled:opacity-50"
                    style={{
                      background: '#3F7A6B',
                      borderRadius: '4px',
                      fontSize: '1rem',
                      minHeight: '52px',
                    }}
                    aria-busy={isThisPending}
                  >
                    {isThisPending ? '更新中...' : ADVANCE_LABEL[toSt]}
                  </button>
                </div>
              )}

              {isDone && (
                <div
                  className="px-4 pb-3 text-sm text-center"
                  style={{ color: '#6B7776' }}
                >
                  完了
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; bg: string; color: string }> = {
    confirmed: { label: '確認済み', bg: '#F6F7F5', color: '#6B7776' },
    enroute: { label: '移動中', bg: '#B9C2BD', color: '#1C2321' },
    in_service: { label: '施術中', bg: '#3F7A6B', color: '#FFFFFF' },
    done: { label: '完了', bg: '#DFE3DE', color: '#6B7776' },
  };
  const s = map[status] ?? { label: status, bg: '#DFE3DE', color: '#1C2321' };
  return (
    <span
      className="text-xs px-2 py-0.5 font-medium"
      style={{ background: s.bg, color: s.color, borderRadius: '4px' }}
    >
      {s.label}
    </span>
  );
}
