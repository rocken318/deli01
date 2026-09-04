"use client";

import { formatInTimeZone } from "date-fns-tz";
import type { PublicSlotView } from "@/lib/availability/public-slots";

/**
 * 縦タイムライン（空き枠の視覚表示 / 発注者要望 2026-09-05）。
 *
 * 営業（シフト）帯を1時間ごとの行にして上→下に並べ、各時間の空き枠を金色の
 * タップ可能なチップで、予約済み区間を「予約済み」ブロックで示す。押すと onPick。
 * 15分刻みのチップ選択は呼び出し側にそのまま残す（本部品は視覚補助）。
 *
 * - 文言は props（content 由来。日本語リテラルを持たない）。
 * - 深夜（翌03:00 まで）も1時間刻みで素直に縦に伸びる（スマホで横スクロール不要）。
 */

const TZ = "Asia/Tokyo";
const HOUR_MS = 3_600_000;

export interface SlotTimelineLabels {
  /** 予約済みブロックの文言（例: "予約済み"） */
  booked: string;
}

export function SlotTimeline({
  slots,
  busy,
  windowStartISO,
  windowEndISO,
  onPick,
  labels,
  pending = false,
}: {
  slots: PublicSlotView[];
  busy: { startISO: string; endISO: string }[];
  windowStartISO: string | null;
  windowEndISO: string | null;
  onPick: (slot: PublicSlotView) => void;
  labels: SlotTimelineLabels;
  pending?: boolean;
}) {
  if (!windowStartISO || !windowEndISO) return null;

  const winStart = Date.parse(windowStartISO);
  const winEnd = Date.parse(windowEndISO);
  if (!Number.isFinite(winStart) || !Number.isFinite(winEnd) || winEnd <= winStart) return null;

  // 時間行の起点（営業開始を含む「時」の 00 分）〜終了までを1時間刻みで
  const firstHour = Math.floor(winStart / HOUR_MS) * HOUR_MS;
  const rows: number[] = [];
  for (let t = firstHour; t < winEnd; t += HOUR_MS) rows.push(t);
  // 上限保険（異常な帯でも描画が暴走しないように）
  if (rows.length === 0 || rows.length > 24) return null;

  const busyMs = busy.map((b) => ({ start: Date.parse(b.startISO), end: Date.parse(b.endISO) }));

  return (
    <div
      className={`overflow-hidden rounded border border-pub-border ${pending ? "opacity-60" : ""}`}
      aria-busy={pending}
    >
      {rows.map((hourStart) => {
        const hourEnd = hourStart + HOUR_MS;
        const hourLabel = formatInTimeZone(new Date(hourStart), TZ, "HH:mm");
        const hourSlots = slots.filter((s) => {
          const t = Date.parse(s.startAtISO);
          return t >= hourStart && t < hourEnd;
        });
        const isBooked =
          hourSlots.length === 0 &&
          busyMs.some((b) => b.start < hourEnd && b.end > hourStart);

        return (
          <div
            key={hourStart}
            className="flex items-stretch gap-3 border-b border-pub-border/60 px-3 py-2 last:border-0"
          >
            <span className="w-14 shrink-0 self-center font-mono text-xs tabular-nums text-pub-subtext">
              {hourLabel}
            </span>
            <div className="flex-1">
              {hourSlots.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {hourSlots.map((s) => (
                    <button
                      key={s.startAtISO}
                      type="button"
                      onClick={() => onPick(s)}
                      className="rounded border border-pub-primary/50 bg-pub-primary/10 px-2.5 py-1 font-mono text-sm font-medium tabular-nums text-pub-primary transition-colors hover:bg-pub-primary hover:text-pub-bg focus-visible:bg-pub-primary focus-visible:text-pub-bg"
                    >
                      {s.time}
                    </button>
                  ))}
                </div>
              ) : isBooked ? (
                <div className="flex h-7 items-center rounded bg-pub-border/50 px-2 text-xs text-pub-subtext">
                  <span
                    aria-hidden="true"
                    className="mr-2 inline-block h-2 w-6 rounded-sm bg-pub-subtext/40"
                  />
                  {labels.booked}
                </div>
              ) : (
                <div className="flex h-7 items-center text-xs text-pub-subtext/30" aria-hidden="true">
                  —
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
