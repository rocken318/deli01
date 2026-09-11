"use client";

import { useState, useRef, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import OrderEntryForm from "@/app/(admin)/admin/orders/OrderEntryForm";
import {
  reorderReservations,
  type ReservationListItem,
} from "@/lib/reservations/list-actions";
import type { TherapistAvailWindow } from "./page";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Therapist {
  id: string;
  slug: string;
  name: string;
}
interface Course {
  id: string;
  name: string;
  duration_min: number;
  price: number;
  nomination_fee_default: number;
}
interface Option {
  id: string;
  name: string;
  price: number;
  duration_min: number;
}
interface Area {
  id: string;
  name: string;
}

interface Props {
  dateISO: string;
  todayISO: string;
  reservations: ReservationListItem[];
  therapists: Therapist[];
  courses: Course[];
  options: Option[];
  areas: Area[];
  availWindows: TherapistAvailWindow[];
}

type SortMode = "manual" | "in" | "out";

// ---------------------------------------------------------------------------
// Status label helper
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  held: { label: "仮押さえ", color: "#8a5d16", bg: "#FBF3E6" },
  confirmed: { label: "確定", color: "#2c6152", bg: "#F3F7F5" },
  enroute: { label: "移動中", color: "#5b625f", bg: "#F6F7F5" },
  in_service: { label: "接客中", color: "#fff", bg: "#B4453C" },
  done: { label: "完了", color: "#5b625f", bg: "#E7E9E7" },
};

function statusStyle(status: string) {
  return STATUS_LABEL[status] ?? { label: status, color: "#5b625f", bg: "#EEE" };
}

function fmtISO(iso: string): string {
  // Format ISO string to HH:MM in JST
  const d = new Date(iso);
  return d.toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ReservationListClient({
  dateISO,
  todayISO,
  reservations,
  therapists,
  courses,
  options,
  areas,
  availWindows,
}: Props) {
  const router = useRouter();
  const [items, setItems] = useState<ReservationListItem[]>(reservations);
  const [sortMode, setSortMode] = useState<SortMode>("manual");
  const [showForm, setShowForm] = useState(false);
  const [isPending, startTransition] = useTransition();

  // D&D state
  const dragIndexRef = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  // Navigate to a different date
  const gotoDate = useCallback(
    (iso: string) => {
      router.push(`/admin/reservation-list?date=${iso}`);
    },
    [router],
  );

  const prevDay = () => {
    const d = new Date(dateISO + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    gotoDate(d.toISOString().slice(0, 10));
  };
  const nextDay = () => {
    const d = new Date(dateISO + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    gotoDate(d.toISOString().slice(0, 10));
  };

  // Sorted view (client-side sort)
  const sorted = [...items].sort((a, b) => {
    if (sortMode === "in") {
      return new Date(a.startAtISO).getTime() - new Date(b.startAtISO).getTime();
    }
    if (sortMode === "out") {
      return new Date(a.endAtISO).getTime() - new Date(b.endAtISO).getTime();
    }
    // manual: manualSortOrder asc nulls last, then startAt
    const ao = a.manualSortOrder ?? Infinity;
    const bo = b.manualSortOrder ?? Infinity;
    if (ao !== bo) return ao - bo;
    return new Date(a.startAtISO).getTime() - new Date(b.startAtISO).getTime();
  });

  // D&D handlers
  const handleDragStart = (index: number) => {
    dragIndexRef.current = index;
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOver(index);
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const fromIndex = dragIndexRef.current;
    if (fromIndex === null || fromIndex === dropIndex) {
      dragIndexRef.current = null;
      setDragOver(null);
      return;
    }

    const newItems = [...sorted];
    const [moved] = newItems.splice(fromIndex, 1);
    if (!moved) return;
    newItems.splice(dropIndex, 0, moved);

    // Apply new manualSortOrder locally
    const withOrder = newItems.map((item, i) => ({
      ...item,
      manualSortOrder: i,
    }));
    setItems(withOrder);
    setSortMode("manual");
    dragIndexRef.current = null;
    setDragOver(null);

    // Persist
    startTransition(async () => {
      await reorderReservations({
        dateISO,
        orderedIds: withOrder.map((x) => x.id),
      });
    });
  };

  const handleDragEnd = () => {
    dragIndexRef.current = null;
    setDragOver(null);
  };

  return (
    <div style={{ display: "flex", gap: 16, padding: 24, background: "#F6F7F5", minHeight: "100vh" }}>
      {/* ─── Main panel ─── */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <h1 style={{ color: "#1C2321", fontSize: 20, fontWeight: 700, margin: 0 }}>予約一覧</h1>
          {/* Date navigation */}
          <button
            onClick={prevDay}
            style={{ border: "1px solid #DFE3DE", background: "#fff", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}
          >
            ← 前日
          </button>
          <input
            type="date"
            value={dateISO}
            onChange={(e) => e.target.value && gotoDate(e.target.value)}
            style={{ border: "1px solid #DFE3DE", borderRadius: 4, padding: "4px 8px", fontSize: 14 }}
          />
          <button
            onClick={nextDay}
            style={{ border: "1px solid #DFE3DE", background: "#fff", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}
          >
            翌日 →
          </button>
          {dateISO !== todayISO && (
            <button
              onClick={() => gotoDate(todayISO)}
              style={{ border: "1px solid #3F7A6B", background: "#EAF3EF", color: "#3F7A6B", borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 13 }}
            >
              当日に戻る
            </button>
          )}
          {isPending && <span style={{ fontSize: 12, color: "#9BA5AF" }}>保存中…</span>}
        </div>

        {/* Sort toggle */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: "#9BA5AF", alignSelf: "center" }}>並び順:</span>
          {(["manual", "in", "out"] as SortMode[]).map((mode) => {
            const labels: Record<SortMode, string> = { manual: "手動順", in: "IN順", out: "OUT順" };
            const active = sortMode === mode;
            return (
              <button
                key={mode}
                onClick={() => setSortMode(mode)}
                style={{
                  border: "1px solid #DFE3DE",
                  background: active ? "#3F7A6B" : "#fff",
                  color: active ? "#fff" : "#1C2321",
                  borderRadius: 4,
                  padding: "3px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {labels[mode]}
              </button>
            );
          })}
        </div>

        {/* Reservation table */}
        {sorted.length === 0 ? (
          <p style={{ color: "#9BA5AF", padding: "16px 0" }}>この日の予約はありません。</p>
        ) : (
          <div style={{ border: "1px solid #DFE3DE", borderRadius: 4, overflow: "hidden", background: "#fff" }}>
            {/* Table header */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "24px 1fr 1.2fr 1.5fr 80px 80px 80px",
                gap: 0,
                background: "#F6F7F5",
                borderBottom: "1px solid #DFE3DE",
                padding: "6px 10px",
                fontSize: 11,
                color: "#9BA5AF",
                fontWeight: 700,
              }}
            >
              <div />
              <div>女性</div>
              <div>コース</div>
              <div>派遣先</div>
              <div style={{ textAlign: "center" }}>IN</div>
              <div style={{ textAlign: "center" }}>OUT</div>
              <div style={{ textAlign: "center" }}>状態</div>
            </div>
            {sorted.map((item, index) => {
              const s = statusStyle(item.status);
              const isDragOver = dragOver === index;
              const hasBreakdown =
                item.totalAmount > 0 ||
                item.transportFee > 0 ||
                item.nominationFee > 0 ||
                item.options.length > 0;
              return (
                <div key={item.id}>
                  <div
                    draggable={sortMode === "manual"}
                    onDragStart={() => handleDragStart(index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDrop={(e) => handleDrop(e, index)}
                    onDragEnd={handleDragEnd}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "24px 1fr 1.2fr 1.5fr 80px 80px 80px",
                      gap: 0,
                      padding: "8px 10px",
                      borderBottom: hasBreakdown ? "none" : "1px solid #DFE3DE",
                      alignItems: "center",
                      cursor: sortMode === "manual" ? "grab" : "default",
                      background: isDragOver ? "#EAF3EF" : "#fff",
                      transition: "background 0.1s",
                    }}
                  >
                    {/* Drag handle */}
                    <div style={{ color: "#9BA5AF", fontSize: 14, userSelect: "none" }}>
                      {sortMode === "manual" ? "⠿" : ""}
                    </div>
                    {/* Therapist / Customer */}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#1C2321" }}>
                        {item.therapistName}
                      </div>
                      {item.customerName && (
                        <div style={{ fontSize: 11, color: "#9BA5AF" }}>{item.customerName}</div>
                      )}
                    </div>
                    {/* Course */}
                    <div style={{ fontSize: 12, color: "#1C2321" }}>
                      {item.courseName}
                      <span style={{ color: "#9BA5AF", fontSize: 11 }}> {item.courseDurationMin}分</span>
                    </div>
                    {/* Location */}
                    <div style={{ fontSize: 12, color: "#1C2321" }}>
                      {item.hotelName ?? item.areaName ?? "—"}
                    </div>
                    {/* IN */}
                    <div
                      style={{
                        textAlign: "center",
                        fontSize: 13,
                        fontFamily: "'IBM Plex Mono', monospace",
                        color: "#3F7A6B",
                        fontWeight: 700,
                      }}
                    >
                      {fmtISO(item.startAtISO)}
                    </div>
                    {/* OUT */}
                    <div
                      style={{
                        textAlign: "center",
                        fontSize: 13,
                        fontFamily: "'IBM Plex Mono', monospace",
                        color: "#5b625f",
                      }}
                    >
                      {fmtISO(item.endAtISO)}
                    </div>
                    {/* Status + Detail link */}
                    <div style={{ textAlign: "center" }}>
                      <Link
                        href={`/admin/reservations/${item.id}`}
                        style={{
                          display: "inline-block",
                          background: s.bg,
                          color: s.color,
                          borderRadius: 3,
                          padding: "2px 7px",
                          fontSize: 11,
                          fontWeight: 600,
                          textDecoration: "none",
                        }}
                      >
                        {s.label}
                      </Link>
                    </div>
                  </div>
                  {/* 金額内訳 */}
                  {hasBreakdown && (
                    <div
                      style={{
                        padding: "4px 10px 8px 34px",
                        borderBottom: "1px solid #DFE3DE",
                        background: isDragOver ? "#EAF3EF" : "#FAFAFA",
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "4px 16px",
                        alignItems: "center",
                      }}
                    >
                      {/* コース */}
                      {item.coursePrice > 0 && (
                        <span style={{ fontSize: 11, color: "#5b625f" }}>
                          コース ¥{item.coursePrice.toLocaleString()}
                        </span>
                      )}
                      {/* 指名料 */}
                      {item.nominationFee > 0 && (
                        <span style={{ fontSize: 11, color: "#5b625f" }}>
                          指名 ¥{item.nominationFee.toLocaleString()}
                        </span>
                      )}
                      {/* オプション個々 */}
                      {item.options.map((opt, i) => (
                        <span key={i} style={{ fontSize: 11, color: "#5b625f" }}>
                          {opt.name} ¥{opt.price.toLocaleString()}
                        </span>
                      ))}
                      {/* 交通費 */}
                      {item.transportFee > 0 && (
                        <span style={{ fontSize: 11, color: "#5b625f" }}>
                          交通費 ¥{item.transportFee.toLocaleString()}
                        </span>
                      )}
                      {/* 合計 */}
                      {item.totalAmount > 0 && (
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: "#1C2321",
                            fontFamily: "'IBM Plex Mono', monospace",
                            marginLeft: "auto",
                          }}
                        >
                          合計 ¥{item.totalAmount.toLocaleString()}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* New booking button + form */}
        <div style={{ marginTop: 20 }}>
          <button
            onClick={() => setShowForm((v) => !v)}
            style={{
              background: "#3F7A6B",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              padding: "8px 18px",
              fontSize: 14,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {showForm ? "▲ フォームを閉じる" : "＋ 新規予約（電話受付）"}
          </button>
          {showForm && (
            <div
              style={{
                marginTop: 12,
                border: "1px solid #DFE3DE",
                borderRadius: 4,
                padding: 16,
                background: "#fff",
              }}
            >
              <OrderEntryForm
                therapists={therapists}
                courses={courses}
                options={options}
                areas={areas}
              />
            </div>
          )}
        </div>
      </div>

      {/* ─── Right panel: therapist availability ─── */}
      <div
        style={{
          width: 220,
          flexShrink: 0,
          border: "1px solid #DFE3DE",
          borderRadius: 4,
          background: "#fff",
          padding: "12px 10px",
          alignSelf: "flex-start",
          position: "sticky",
          top: 16,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: "#3F7A6B", marginBottom: 8 }}>
          派遣できるセラピスト
        </div>
        {availWindows.length === 0 ? (
          <p style={{ fontSize: 12, color: "#9BA5AF" }}>出勤中のセラピストがいません。</p>
        ) : (
          availWindows.map((w) => (
            <div
              key={w.therapistId}
              style={{
                borderBottom: "1px solid #DFE3DE",
                paddingBottom: 8,
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: "#1C2321" }}>{w.name}</div>
              {w.kind === "now" && (
                <div style={{ fontSize: 13, fontWeight: 700, color: "#3F7A6B", fontFamily: "'IBM Plex Mono',monospace" }}>
                  今すぐ
                  {w.untilLabel && (
                    <span style={{ fontSize: 11, fontWeight: 400, color: "#9BA5AF" }}>〜{w.untilLabel}</span>
                  )}
                </div>
              )}
              {w.kind === "from" && w.fromLabel && (
                <div style={{ fontSize: 13, fontWeight: 700, color: "#C98A2B", fontFamily: "'IBM Plex Mono',monospace" }}>
                  {w.fromLabel}
                  {w.untilLabel && (
                    <span style={{ fontSize: 11, fontWeight: 400, color: "#9BA5AF" }}>〜{w.untilLabel}</span>
                  )}
                </div>
              )}
              {w.kind === "done" && (
                <div style={{ fontSize: 11, color: "#9BA5AF" }}>上がり</div>
              )}
              {w.gapMin !== null && w.gapMin > 0 && (
                <div style={{ fontSize: 10, color: "#9BA5AF" }}>空き{w.gapMin}分</div>
              )}
              {w.busyNow && (
                <div style={{ fontSize: 10, color: "#B4453C", fontWeight: 600 }}>接客中</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
