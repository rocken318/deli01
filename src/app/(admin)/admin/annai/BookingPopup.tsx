"use client";

/**
 * 案内表インライン予約ポップ（P1b）。行の下に開く横長フォーム。
 * 料金・排他・作成は既存 createPhoneOrder（createHold 経由）を再利用。
 * 総額は previewOrderTotal（feeBreakdown 再利用）を debounce で表示。延長は P2 送り。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { fromZonedTime } from "date-fns-tz";
import {
  searchCustomerByPhone,
  searchHotels,
  createPhoneOrder,
} from "@/app/(admin)/admin/orders/actions";
import { previewOrderTotal } from "@/app/(admin)/admin/orders/preview-actions";

export interface CourseOpt {
  id: string;
  name: string;
  price: number;
  duration_min: number;
  nomination_fee_default: number;
}
export interface OptionOpt {
  id: string;
  name: string;
  price: number;
}
export interface AreaOpt {
  id: string;
  name: string;
}

const TZ = "Asia/Tokyo";
const T = {
  bg: "#FFFFFF",
  border: "#DFE3DE",
  text: "#1C2321",
  muted: "#6B7776",
  primary: "#3F7A6B",
  danger: "#B4453C",
  radius: "6px",
} as const;

const field: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  borderRadius: T.radius,
  padding: "6px 8px",
  fontSize: 13,
  color: T.text,
  background: "#fff",
  colorScheme: "light",
};

export default function BookingPopup({
  therapistId,
  therapistSlug,
  todayISO,
  defaultHHMM,
  courses,
  options,
  areas,
  onCreated,
}: {
  therapistId: string;
  therapistSlug: string;
  todayISO: string; // YYYY-MM-DD (JST)
  defaultHHMM: string; // "HH:MM"（空き窓の開始）
  courses: CourseOpt[];
  options: OptionOpt[];
  areas: AreaOpt[];
  onCreated: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [optionIds, setOptionIds] = useState<string[]>([]);
  const [hhmm, setHhmm] = useState(defaultHHMM);
  const [dest, setDest] = useState<"hotel" | "home">("hotel");
  const [areaId, setAreaId] = useState(areas[0]?.id ?? "");
  const [hotelQuery, setHotelQuery] = useState("");
  const [hotelId, setHotelId] = useState("");
  const [hotelName, setHotelName] = useState("");
  const [hotelSuggests, setHotelSuggests] = useState<{ id: string; name: string; areaId: string | null; entryNote: string | null }[]>([]);
  const [roomNumber, setRoomNumber] = useState("");
  const [preferences, setPreferences] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  const startAtISO = useMemo(() => {
    try {
      return fromZonedTime(`${todayISO}T${hhmm}:00`, TZ).toISOString();
    } catch {
      return "";
    }
  }, [todayISO, hhmm]);

  // 電話番号→顧客補完（debounce）
  const phoneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (phoneTimer.current) clearTimeout(phoneTimer.current);
    if (phone.replace(/\D/g, "").length < 10) return;
    phoneTimer.current = setTimeout(async () => {
      const r = await searchCustomerByPhone(phone);
      if (r.ok && r.data) {
        const d = r.data;
        if (d.name) setName((n) => n || d.name);
        if (d.note) setPreferences((p) => p || (d.note ?? ""));
      }
    }, 400);
  }, [phone]);

  // ホテル検索（debounce）
  const hotelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hotelTimer.current) clearTimeout(hotelTimer.current);
    if (dest !== "hotel" || hotelQuery.trim().length === 0) {
      setHotelSuggests([]);
      return;
    }
    hotelTimer.current = setTimeout(async () => {
      const r = await searchHotels(hotelQuery);
      if (r.ok && r.data) {
        setHotelSuggests(r.data.map((h) => ({ id: h.id, name: h.name, areaId: h.areaId, entryNote: h.entryNote })));
      }
    }, 350);
  }, [hotelQuery, dest]);

  // 総額プレビュー（debounce）
  const totalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (totalTimer.current) clearTimeout(totalTimer.current);
    if (!courseId || !startAtISO) {
      setTotal(null);
      return;
    }
    totalTimer.current = setTimeout(async () => {
      const r = await previewOrderTotal({ courseId, optionIds, startAtISO, travelInMode: "car" });
      setTotal(r.ok ? r.data.totalAmount : null);
    }, 300);
  }, [courseId, optionIds, startAtISO]);

  const selectHotel = (h: { id: string; name: string; areaId: string | null; entryNote: string | null }) => {
    setHotelId(h.id);
    setHotelName(h.name);
    setHotelQuery(h.name);
    setHotelSuggests([]);
    if (h.areaId) setAreaId(h.areaId);
    if (h.entryNote) setPreferences((p) => (p.includes(h.entryNote!) ? p : `${p ? p + "\n" : ""}${h.name}: ${h.entryNote}`));
  };

  const toggleOpt = (id: string) =>
    setOptionIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = async () => {
    setState("sending");
    setMsg("");
    try {
      const r = await createPhoneOrder({
        phone,
        customerName: name,
        destinationType: dest,
        areaId: dest === "home" ? areaId : undefined,
        hotelId: dest === "hotel" ? hotelId || undefined : undefined,
        roomNumber: roomNumber || undefined,
        therapistId,
        therapistSlug,
        courseId,
        optionIds,
        startAtISO,
        preferences: preferences || undefined,
      });
      if (r.ok) {
        setState("done");
        setMsg("予約を作成しました");
        onCreated();
      } else {
        setState("error");
        setMsg(r.error ?? "予約を作成できませんでした");
      }
    } catch {
      setState("error");
      setMsg("通信に失敗しました");
    }
  };

  if (state === "done") {
    return (
      <div style={{ borderTop: `2px dashed ${T.primary}`, paddingTop: 10, marginTop: 8, color: T.primary, fontSize: 14 }}>
        ✓ {msg}
      </div>
    );
  }

  return (
    <div style={{ borderTop: `2px dashed ${T.primary}`, paddingTop: 10, marginTop: 8, display: "grid", gridTemplateColumns: "1fr 190px", gap: 12 }}>
      <div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
          <label style={{ fontSize: 10, color: T.muted }}>電話<br /><input style={{ ...field, width: 118 }} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="090…" /></label>
          <label style={{ fontSize: 10, color: T.muted }}>名前<br /><input style={{ ...field, width: 90 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="サトウ" /></label>
          <label style={{ fontSize: 10, color: T.muted }}>コース<br />
            <select style={field} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 10, color: T.muted }}>開始<br /><input style={{ ...field, width: 64 }} type="time" value={hhmm} onChange={(e) => setHhmm(e.target.value)} /></label>
        </div>

        {/* 場所 */}
        <div style={{ display: "flex", gap: 8, alignItems: "end", marginTop: 8, flexWrap: "wrap" }}>
          <label style={{ fontSize: 10, color: T.muted }}>場所<br />
            <select style={field} value={dest} onChange={(e) => setDest(e.target.value as "hotel" | "home")}>
              <option value="hotel">ホテル</option>
              <option value="home">自宅・待合</option>
            </select>
          </label>
          {dest === "hotel" ? (
            <div style={{ position: "relative" }}>
              <label style={{ fontSize: 10, color: T.muted }}>ホテル検索<br />
                <input style={{ ...field, width: 170 }} value={hotelQuery} onChange={(e) => { setHotelQuery(e.target.value); setHotelId(""); }} placeholder="ホテル名" />
              </label>
              {hotelSuggests.length > 0 && (
                <div style={{ position: "absolute", zIndex: 5, background: "#fff", border: `1px solid ${T.border}`, borderRadius: 6, width: 220, maxHeight: 160, overflowY: "auto" }}>
                  {hotelSuggests.map((h) => (
                    <button key={h.id} type="button" onClick={() => selectHotel(h)} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", fontSize: 12, background: "#fff", border: "none", borderBottom: `1px solid ${T.border}`, cursor: "pointer" }}>{h.name}</button>
                  ))}
                </div>
              )}
              {hotelId && <span style={{ fontSize: 11, color: T.primary, marginLeft: 4 }}>✓{hotelName}</span>}
            </div>
          ) : (
            <label style={{ fontSize: 10, color: T.muted }}>エリア<br />
              <select style={field} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
                {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
          <label style={{ fontSize: 10, color: T.muted }}>部屋<br /><input style={{ ...field, width: 70 }} value={roomNumber} onChange={(e) => setRoomNumber(e.target.value)} placeholder="号室" /></label>
        </div>

        {/* オプション */}
        {options.length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
            {options.map((o) => {
              const on = optionIds.includes(o.id);
              return (
                <button key={o.id} type="button" onClick={() => toggleOpt(o.id)}
                  style={{ fontSize: 11, borderRadius: 5, padding: "4px 8px", cursor: "pointer", border: `1px solid ${on ? T.primary : T.border}`, background: on ? T.primary : "#fff", color: on ? "#fff" : T.muted }}>
                  {o.name}+¥{o.price.toLocaleString()}
                </button>
              );
            })}
          </div>
        )}

        {/* 備考 */}
        <textarea rows={2} value={preferences} onChange={(e) => setPreferences(e.target.value)} placeholder="★備考: 服装・ホテルの入り方・注意など"
          style={{ width: "100%", boxSizing: "border-box", border: `2px solid #C98A2B`, borderRadius: 6, padding: 6, fontSize: 12, marginTop: 8, resize: "vertical" }} />
      </div>

      {/* 総額 */}
      <div style={{ background: "#151A20", borderRadius: 10, padding: 12, color: "#EDE9E2", height: "fit-content" }}>
        <div style={{ fontSize: 11, color: "#9BA5AF" }}>総額（お客様へ）</div>
        <div style={{ fontSize: 30, fontWeight: 800, color: "#C6A15B", fontFamily: "'IBM Plex Mono',monospace", lineHeight: 1, margin: "2px 0 8px" }}>
          {total !== null ? `¥${total.toLocaleString()}` : "—"}
        </div>
        <button type="button" onClick={submit} disabled={state === "sending" || !phone || !name || !courseId}
          style={{ width: "100%", background: "#C6A15B", color: "#151A20", border: "none", borderRadius: 8, padding: 10, fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
          {state === "sending" ? "作成中…" : "予約する"}
        </button>
        {state === "error" && <p style={{ color: "#e79", fontSize: 12, marginTop: 8, whiteSpace: "pre-wrap" }}>{msg}</p>}
      </div>
    </div>
  );
}
