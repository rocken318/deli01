"use client";

/**
 * 案内表：1セラピスト×1日のタイムライン帯。
 * 予約 job セグメント（灰橙）と空き gap セグメント（緑・tooShort は橙）を横比例で表示。
 * gap クリックで onPickGap(startMs) を呼ぶ。
 * 管理側 → 日本語直書き可。spec 12-2 色使い。
 */

import Link from "next/link";
import type { TimelineSegment } from "@/domain/annai";

const TZ_OFFSET = 9 * 60; // JST は UTC+9

/** ms → "HH:mm" (JST)。営業日またぎ表記は案内表側 hm ヘルパに任せるが、
 *  コンポーネントは opDay を受け取り同じ 24時越え表記に対応する。 */
function fmt(ms: number, opDay: string): string {
  // opDay は "yyyy-MM-dd" 形式（JST）。
  // ms を JST で "yyyy-MM-dd" に変換して比較。
  const jstMs = ms + TZ_OFFSET * 60_000;
  const jstDate = new Date(jstMs);
  const ymd = `${jstDate.getUTCFullYear()}-${String(jstDate.getUTCMonth() + 1).padStart(2, "0")}-${String(jstDate.getUTCDate()).padStart(2, "0")}`;
  const h = jstDate.getUTCHours();
  const m = String(jstDate.getUTCMinutes()).padStart(2, "0");
  if (ymd > opDay) {
    return `${h + 24}:${m}`;
  }
  return `${String(h).padStart(2, "0")}:${m}`;
}

interface DayTimelineProps {
  segments: TimelineSegment[];
  opDay: string;
  onPickGap: (startMs: number) => void;
}

export default function DayTimeline({ segments, opDay, onPickGap }: DayTimelineProps) {
  if (segments.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "#9BA5AF", padding: "4px 0", marginTop: 4 }}>
        上がり／未出勤
      </div>
    );
  }

  const totalMin = segments.reduce((acc, s) => acc + s.minutes, 0);

  return (
    <div
      style={{
        display: "flex",
        overflowX: "auto",
        marginTop: 6,
        borderRadius: 5,
        border: "1px solid #DFE3DE",
        minHeight: 36,
      }}
    >
      {segments.map((seg, i) => {
        // 幅は minutes に比例（totalMin > 0 の場合）
        const flexGrow = totalMin > 0 ? seg.minutes / totalMin : 1;
        // 最小幅: job は 52px、gap は 64px（テキストが潰れないように）
        const minWidth = seg.kind === "job" ? 52 : 64;

        if (seg.kind === "job") {
          const startStr = fmt(seg.startMs, opDay);
          const endStr = fmt(seg.endMs, opDay);
          const amount = seg.job?.totalAmount;
          const reservationId = seg.job?.id;
          const title = `予約 ${startStr}–${endStr}${amount != null ? ` ¥${amount.toLocaleString()}` : ""}`;
          const inner = (
            <div
              style={{
                fontSize: 10,
                lineHeight: 1.3,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              <div style={{ fontWeight: 700 }}>
                {startStr}–{endStr}
              </div>
              {amount != null && (
                <div style={{ color: "#8a5d16" }}>¥{amount.toLocaleString()}</div>
              )}
            </div>
          );

          const cellStyle: React.CSSProperties = {
            flexGrow,
            flexShrink: 0,
            flexBasis: 0,
            minWidth,
            background: "#F6EDDE",
            borderRight: i < segments.length - 1 ? "1px solid #DFE3DE" : undefined,
            padding: "4px 6px",
            color: "#5a3d0a",
            textDecoration: "none",
            display: "block",
            cursor: "pointer",
          };

          if (reservationId) {
            return (
              <Link
                key={i}
                href={`/admin/reservations/${reservationId}`}
                title={title}
                style={cellStyle}
              >
                {inner}
              </Link>
            );
          }
          return (
            <div key={i} title={title} style={{ ...cellStyle, cursor: "default" }}>
              {inner}
            </div>
          );
        }

        // gap セグメント
        const startStr = fmt(seg.startMs, opDay);
        const endStr = fmt(seg.endMs, opDay);
        const isTooShort = seg.tooShort === true;
        const isNow = seg.isNow === true;

        const gapLabel = isNow
          ? `今すぐ〜${endStr}（${seg.minutes}分）`
          : `${startStr}〜${endStr}（${seg.minutes}分）`;

        const bg = isTooShort ? "#FBF3E6" : "#EAF3EF";
        const textColor = isTooShort ? "#8a5d16" : "#245043";
        const borderColor = isTooShort ? "#E0B36B" : "#B3D9CC";

        return (
          <button
            key={i}
            type="button"
            title={gapLabel}
            onClick={() => onPickGap(seg.startMs)}
            style={{
              flexGrow,
              flexShrink: 0,
              flexBasis: 0,
              minWidth,
              background: bg,
              borderRight: i < segments.length - 1 ? `1px solid ${borderColor}` : undefined,
              borderLeft: "none",
              borderTop: "none",
              borderBottom: "none",
              padding: "4px 6px",
              color: textColor,
              fontSize: 10,
              lineHeight: 1.3,
              cursor: "pointer",
              textAlign: "left",
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
            }}
          >
            <div style={{ fontWeight: 700 }}>
              {isNow ? "今すぐ" : startStr}〜{endStr}
            </div>
            <div>
              {seg.minutes}分{isTooShort && <span style={{ color: "#B4453C", fontWeight: 700, marginLeft: 3 }}>短</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
