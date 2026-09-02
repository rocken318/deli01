"use client";

/**
 * 案内表インライン予約ポップ（P1b）。
 * 開始時刻は engine の実枠（getAnnaiBookingSlots）から選ぶ＝createHold と exact 一致・
 * 総額も枠に乗った実額（作成される予約と一致）。作成は createPhoneOrder（排他/engine 再利用）。
 * 延長は P2 送り。交通費・オプション絞込は枠計算に含まれる。
 */

import { useEffect, useRef, useState } from "react";
import {
  searchCustomerByPhone,
  searchHotels,
  createPhoneOrder,
} from "@/app/(admin)/admin/orders/actions";
import { getAnnaiBookingSlots, type AnnaiSlot } from "./booking-actions";

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

const T = {
  border: "#DFE3DE",
  text: "#1C2321",
  muted: "#6B7776",
  primary: "#3F7A6B",
} as const;

const field: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
  color: T.text,
  background: "#fff",
  colorScheme: "light",
};

export default function BookingPopup({
  therapistId,
  therapistSlug,
  courses,
  options,
  areas,
  onCreated,
}: {
  therapistId: string;
  therapistSlug: string;
  courses: CourseOpt[];
  options: OptionOpt[];
  areas: AreaOpt[];
  onCreated: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [optionIds, setOptionIds] = useState<string[]>([]);
  const [dest, setDest] = useState<"hotel" | "home">("hotel");
  const [areaId, setAreaId] = useState(areas[0]?.id ?? "");
  const [hotelQuery, setHotelQuery] = useState("");
  const [hotelId, setHotelId] = useState("");
  const [hotelName, setHotelName] = useState("");
  const [hotelEntryNote, setHotelEntryNote] = useState<string | null>(null);
  const [hotelSuggests, setHotelSuggests] = useState<{ id: string; name: string; areaId: string | null; entryNote: string | null }[]>([]);
  const [addressDetail, setAddressDetail] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const [preferences, setPreferences] = useState("");
  const [slots, setSlots] = useState<AnnaiSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [selectedISO, setSelectedISO] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  const selectedTotal = slots.find((s) => s.startAtISO === selectedISO)?.totalAmount ?? null;

  // 電話→顧客補完
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

  // ホテル検索
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

  // 実枠＋総額の取得（条件が変わるたび）
  const slotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (slotTimer.current) clearTimeout(slotTimer.current);
    const needPlace = dest === "hotel" ? !!hotelId : !!areaId;
    if (!courseId || !needPlace) {
      setSlots([]);
      setSelectedISO("");
      return;
    }
    setSlotsLoading(true);
    slotTimer.current = setTimeout(async () => {
      const r = await getAnnaiBookingSlots({
        therapistSlug,
        courseId,
        optionIds,
        areaId: dest === "home" ? areaId : null,
        hotelId: dest === "hotel" ? hotelId : null,
      });
      setSlotsLoading(false);
      if (r.ok) {
        setSlots(r.data.slots);
        setSelectedISO((prev) => (r.data.slots.some((s) => s.startAtISO === prev) ? prev : (r.data.slots[0]?.startAtISO ?? "")));
      } else {
        setSlots([]);
        setSelectedISO("");
      }
    }, 350);
  }, [therapistSlug, courseId, optionIds, dest, hotelId, areaId]);

  const selectHotel = (h: { id: string; name: string; areaId: string | null; entryNote: string | null }) => {
    setHotelId(h.id);
    setHotelName(h.name);
    setHotelQuery(h.name);
    setHotelSuggests([]);
    setHotelEntryNote(h.entryNote);
    if (h.areaId) setAreaId(h.areaId);
  };

  const toggleOpt = (id: string) =>
    setOptionIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const canSubmit =
    !!selectedISO &&
    !!phone &&
    !!name &&
    !!courseId &&
    (dest === "hotel" ? !!hotelId : !!areaId && !!addressDetail.trim()) &&
    state !== "sending";

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
        addressDetail: dest === "home" ? addressDetail : undefined,
        roomNumber: roomNumber || undefined,
        therapistId,
        therapistSlug,
        courseId,
        optionIds,
        startAtISO: selectedISO,
        preferences: preferences || undefined,
      });
      if (r.ok) {
        setState("done");
        setMsg("予約を作成しました");
        onCreated();
      } else {
        setState("error");
        setMsg(r.error === "枠外予約には理由が必要です" ? "この時刻は枠として案内できません（別の枠を選ぶか、電話受付画面から枠外予約を）" : (r.error ?? "予約を作成できませんでした"));
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
                <input style={{ ...field, width: 170 }} value={hotelQuery} onChange={(e) => { setHotelQuery(e.target.value); setHotelId(""); setHotelEntryNote(null); }} placeholder="ホテル名（選択必須）" />
              </label>
              {hotelSuggests.length > 0 && (
                <div style={{ position: "absolute", zIndex: 5, background: "#fff", border: `1px solid ${T.border}`, borderRadius: 6, width: 240, maxHeight: 160, overflowY: "auto" }}>
                  {hotelSuggests.map((h) => (
                    <button key={h.id} type="button" onClick={() => selectHotel(h)} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", fontSize: 12, background: "#fff", border: "none", borderBottom: `1px solid ${T.border}`, cursor: "pointer" }}>{h.name}</button>
                  ))}
                </div>
              )}
              {hotelId && <span style={{ fontSize: 11, color: T.primary, marginLeft: 4 }}>✓{hotelName}</span>}
            </div>
          ) : (
            <>
              <label style={{ fontSize: 10, color: T.muted }}>エリア<br />
                <select style={field} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
                  {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 10, color: T.muted }}>住所<br /><input style={{ ...field, width: 180 }} value={addressDetail} onChange={(e) => setAddressDetail(e.target.value)} placeholder="待合せ場所・住所（必須）" /></label>
            </>
          )}
          <label style={{ fontSize: 10, color: T.muted }}>部屋<br /><input style={{ ...field, width: 70 }} value={roomNumber} onChange={(e) => setRoomNumber(e.target.value)} placeholder="号室" /></label>
        </div>

        {/* ホテルの入り方（読取ヒント・備考は汚さない） */}
        {dest === "hotel" && hotelEntryNote && (
          <p style={{ fontSize: 11, color: "#8a5d16", marginTop: 4, whiteSpace: "pre-wrap" }}>入り方: {hotelEntryNote}</p>
        )}

        {/* 開始（実枠から選ぶ） */}
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 10, color: T.muted }}>開始（案内できる枠）<br />
            <select style={{ ...field, minWidth: 170 }} value={selectedISO} onChange={(e) => setSelectedISO(e.target.value)} disabled={slots.length === 0}>
              {slots.length === 0 ? (
                <option value="">{slotsLoading ? "枠を計算中…" : "先に場所を選択"}</option>
              ) : (
                slots.map((s) => <option key={s.startAtISO} value={s.startAtISO}>{s.time}　¥{s.totalAmount.toLocaleString()}</option>)
              )}
            </select>
          </label>
          {!slotsLoading && slots.length === 0 && (dest === "hotel" ? hotelId : areaId) && (
            <span style={{ fontSize: 11, color: "#B4453C", marginLeft: 8 }}>この条件で案内できる枠がありません</span>
          )}
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
        <textarea rows={2} value={preferences} onChange={(e) => setPreferences(e.target.value)} placeholder="★備考: 服装・注意など"
          style={{ width: "100%", boxSizing: "border-box", border: `2px solid #C98A2B`, borderRadius: 6, padding: 6, fontSize: 12, marginTop: 8, resize: "vertical" }} />
      </div>

      {/* 総額（選んだ枠の実額） */}
      <div style={{ background: "#151A20", borderRadius: 10, padding: 12, color: "#EDE9E2", height: "fit-content" }}>
        <div style={{ fontSize: 11, color: "#9BA5AF" }}>総額（お客様へ）</div>
        <div style={{ fontSize: 30, fontWeight: 800, color: "#C6A15B", fontFamily: "'IBM Plex Mono',monospace", lineHeight: 1, margin: "2px 0 8px" }}>
          {selectedTotal !== null ? `¥${selectedTotal.toLocaleString()}` : "—"}
        </div>
        <button type="button" onClick={submit} disabled={!canSubmit}
          style={{ width: "100%", background: canSubmit ? "#C6A15B" : "#7d7461", color: "#151A20", border: "none", borderRadius: 8, padding: 10, fontSize: 14, fontWeight: 800, cursor: canSubmit ? "pointer" : "not-allowed" }}>
          {state === "sending" ? "作成中…" : "予約する"}
        </button>
        {state === "error" && <p style={{ color: "#e79", fontSize: 12, marginTop: 8, whiteSpace: "pre-wrap" }}>{msg}</p>}
      </div>
    </div>
  );
}
