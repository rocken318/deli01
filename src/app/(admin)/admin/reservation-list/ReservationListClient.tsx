"use client";

import { useState, useRef, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import OrderEntryForm from "@/app/(admin)/admin/orders/OrderEntryForm";
import {
  reorderReservations,
  type ReservationListItem,
} from "@/lib/reservations/list-actions";
import { setReservationRoomNumber } from "@/lib/reservations/room-actions";
import { addSameDayExtension } from "@/lib/booking/extension-actions";
import { buildTherapistNotice } from "@/domain/reservation/therapist-notice";
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

// Statuses where card operations (OP add, room edit) are enabled
const OPERABLE_STATUSES = new Set(["confirmed", "enroute", "in_service"]);

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
  const d = new Date(iso);
  return d.toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Toast helper (simple inline toast state)
// ---------------------------------------------------------------------------

interface ToastMsg {
  id: number;
  text: string;
  kind: "ok" | "error" | "warn";
}

let _toastCounter = 0;

// ---------------------------------------------------------------------------
// OP追加パネル (per-card)
// ---------------------------------------------------------------------------

interface OpAddPanelProps {
  reservationId: string;
  options: Option[];
  onDone: (updatedId: string) => void;
  onToast: (text: string, kind: ToastMsg["kind"]) => void;
}

function OpAddPanel({ reservationId, options, onDone, onToast }: OpAddPanelProps) {
  const [selectedOptionId, setSelectedOptionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);

  const doAdd = useCallback(
    async (overrideReason?: string) => {
      if (!selectedOptionId) return;
      setBusy(true);
      setConflictError(null);

      const result = await addSameDayExtension(
        reservationId,
        selectedOptionId,
        overrideReason ? { overrideReason } : undefined,
      );

      setBusy(false);

      if (result.ok) {
        onToast("オプションを追加しました", "ok");
        setSelectedOptionId("");
        onDone(reservationId);
      } else {
        // If there's a conflict-like error, offer override
        const isConflict =
          result.error?.includes("後続") || result.error?.includes("間に合わない");
        if (isConflict) {
          setConflictError(result.error ?? "後続予約と競合しています");
        } else {
          onToast(result.error ?? "追加に失敗しました", "error");
        }
      }
    },
    [reservationId, selectedOptionId, onDone, onToast],
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <select
        value={selectedOptionId}
        onChange={(e) => {
          setSelectedOptionId(e.target.value);
          setConflictError(null);
        }}
        disabled={busy}
        style={{
          fontSize: 12,
          border: "1px solid #DFE3DE",
          borderRadius: 3,
          padding: "2px 6px",
          background: "#fff",
          color: "#1C2321",
          maxWidth: 160,
        }}
      >
        <option value="">OP選択…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ¥{o.price.toLocaleString()} +{o.duration_min}分
          </option>
        ))}
      </select>
      <button
        onClick={() => doAdd()}
        disabled={!selectedOptionId || busy}
        style={{
          fontSize: 11,
          border: "1px solid #3F7A6B",
          background: selectedOptionId && !busy ? "#EAF3EF" : "#F6F7F5",
          color: selectedOptionId && !busy ? "#3F7A6B" : "#9BA5AF",
          borderRadius: 3,
          padding: "2px 8px",
          cursor: selectedOptionId && !busy ? "pointer" : "default",
        }}
      >
        {busy ? "追加中…" : "追加"}
      </button>
      {conflictError && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "#FBF3E6",
            border: "1px solid #C98A2B",
            borderRadius: 3,
            padding: "3px 8px",
            fontSize: 11,
            color: "#8a5d16",
            flexWrap: "wrap",
          }}
        >
          <span>⚠ {conflictError}</span>
          <button
            onClick={() => doAdd("管理者による強制追加（後続確認済み）")}
            disabled={busy}
            style={{
              fontSize: 11,
              border: "1px solid #C98A2B",
              background: "#fff",
              color: "#8a5d16",
              borderRadius: 3,
              padding: "2px 8px",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            それでも追加
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 部屋番号インライン入力
// ---------------------------------------------------------------------------

interface RoomNumberInputProps {
  reservationId: string;
  initial: string | null;
  onToast: (text: string, kind: ToastMsg["kind"]) => void;
}

function RoomNumberInput({ reservationId, initial, onToast }: RoomNumberInputProps) {
  const [value, setValue] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);

  const isDirty = value !== saved;

  const save = useCallback(async () => {
    setBusy(true);
    const result = await setReservationRoomNumber({ reservationId, roomNumber: value });
    setBusy(false);
    if (result.ok) {
      setSaved(value);
      onToast("部屋番号を保存しました", "ok");
    } else {
      onToast(result.error ?? "保存に失敗しました", "error");
    }
  }, [reservationId, value, onToast]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 11, color: "#9BA5AF", whiteSpace: "nowrap" }}>部屋:</span>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="例: 302"
        maxLength={50}
        disabled={busy}
        style={{
          fontSize: 12,
          border: `1px solid ${isDirty ? "#C98A2B" : "#DFE3DE"}`,
          borderRadius: 3,
          padding: "2px 6px",
          width: 70,
          background: "#fff",
          color: "#1C2321",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      {isDirty && (
        <button
          onClick={save}
          disabled={busy}
          style={{
            fontSize: 11,
            border: "1px solid #3F7A6B",
            background: "#EAF3EF",
            color: "#3F7A6B",
            borderRadius: 3,
            padding: "2px 6px",
            cursor: "pointer",
          }}
        >
          {busy ? "…" : "保存"}
        </button>
      )}
    </div>
  );
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
  const [toasts, setToasts] = useState<ToastMsg[]>([]);

  // D&D state
  const dragIndexRef = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  // Track which cards have the OP panel open
  const [opOpenIds, setOpOpenIds] = useState<Set<string>>(new Set());

  const showToast = useCallback((text: string, kind: ToastMsg["kind"]) => {
    const id = ++_toastCounter;
    setToasts((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }, []);

  // Reload a single reservation's data by refreshing the full list via router
  const refreshList = useCallback(
    (_updatedId: string) => {
      router.refresh();
    },
    [router],
  );

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

  const handleCopyNotice = useCallback(
    (item: ReservationListItem) => {
      if (!item.roomNumber) {
        showToast("部屋番号が未入力ですがコピーします", "warn");
      }
      const text = buildTherapistNotice({
        therapistName: item.therapistName,
        startText: fmtISO(item.startAtISO),
        courseName: item.courseName,
        courseDurationMin: item.courseDurationMin,
        destination: item.hotelName ?? item.areaName ?? "—",
        roomNumber: item.roomNumber ?? null,
        optionNames: item.options.map((o) => o.name),
        totalAmount: item.totalAmount,
      });
      navigator.clipboard.writeText(text).then(
        () => {
          if (item.roomNumber) showToast("セラピスト連絡文をコピーしました", "ok");
        },
        () => showToast("クリップボードへのコピーに失敗しました", "error"),
      );
    },
    [showToast],
  );

  return (
    <div style={{ display: "flex", gap: 16, padding: 24, background: "#F6F7F5", minHeight: "100vh" }}>
      {/* ─── Toast overlay ─── */}
      {toasts.length > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            zIndex: 9999,
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              style={{
                padding: "8px 14px",
                borderRadius: 4,
                fontSize: 13,
                fontWeight: 600,
                background:
                  t.kind === "ok" ? "#EAF3EF" : t.kind === "warn" ? "#FBF3E6" : "#FDECEA",
                color:
                  t.kind === "ok" ? "#2c6152" : t.kind === "warn" ? "#8a5d16" : "#B4453C",
                border: `1px solid ${t.kind === "ok" ? "#3F7A6B" : t.kind === "warn" ? "#C98A2B" : "#B4453C"}`,
                boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
              }}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}

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
              const canOperate = OPERABLE_STATUSES.has(item.status);
              const opOpen = opOpenIds.has(item.id);

              return (
                <div key={item.id}>
                  {/* Main row */}
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
                        borderBottom: canOperate ? "none" : "1px solid #DFE3DE",
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

                  {/* カード操作行（confirmed/enroute/in_service のみ） */}
                  {canOperate && (
                    <div
                      style={{
                        padding: "6px 10px 8px 34px",
                        borderBottom: "1px solid #DFE3DE",
                        background: isDragOver ? "#EAF3EF" : "#F6F7F5",
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "6px 16px",
                        alignItems: "flex-start",
                      }}
                    >
                      {/* OP追加ボタン */}
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                        <button
                          onClick={() =>
                            setOpOpenIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(item.id)) {
                                next.delete(item.id);
                              } else {
                                next.add(item.id);
                              }
                              return next;
                            })
                          }
                          style={{
                            fontSize: 11,
                            border: "1px solid #DFE3DE",
                            background: opOpen ? "#EAF3EF" : "#fff",
                            color: opOpen ? "#3F7A6B" : "#5b625f",
                            borderRadius: 3,
                            padding: "2px 8px",
                            cursor: "pointer",
                            fontWeight: 600,
                          }}
                        >
                          ＋OP
                        </button>
                        {opOpen && (
                          <OpAddPanel
                            reservationId={item.id}
                            options={options}
                            onDone={refreshList}
                            onToast={showToast}
                          />
                        )}
                      </div>

                      {/* 部屋番号入力 */}
                      <RoomNumberInput
                        reservationId={item.id}
                        initial={item.roomNumber}
                        onToast={showToast}
                      />

                      {/* セラピストへ送る */}
                      <button
                        onClick={() => handleCopyNotice(item)}
                        style={{
                          fontSize: 11,
                          border: "1px solid #DFE3DE",
                          background: "#fff",
                          color: "#5b625f",
                          borderRadius: 3,
                          padding: "2px 8px",
                          cursor: "pointer",
                        }}
                      >
                        📋 セラピストへ送る
                      </button>
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
