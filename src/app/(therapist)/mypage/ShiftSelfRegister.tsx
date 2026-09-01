"use client";

import { useState } from "react";
import { saveMyShiftAction, saveMyShiftsBulkAction } from "@/lib/shifts/self-actions";

// Design tokens（spec 12-2 / mypage の他セクションと統一）
const T = {
  bg: "#FFFFFF",
  text: "#1C2321",
  border: "#DFE3DE",
  primary: "#3F7A6B",
  muted: "#6B7776",
  danger: "#B4453C",
  radius: "4px",
} as const;

const WEEKDAYS = [
  { v: 1, label: "月" },
  { v: 2, label: "火" },
  { v: 3, label: "水" },
  { v: 4, label: "木" },
  { v: 5, label: "金" },
  { v: 6, label: "土" },
  { v: 0, label: "日" },
];

const reasonMsg: Record<string, string> = {
  unauthenticated: "ログインが必要です",
  no_therapist: "セラピストアカウントが見つかりません",
  invalid: "入力を確認してください",
  no_dates: "該当する日がありません（曜日と期間を確認してください）",
  error: "登録できませんでした",
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: T.muted,
  marginBottom: 4,
};
const input: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  padding: "8px 10px",
  borderRadius: T.radius,
  border: `1px solid ${T.border}`,
  background: "#FFFFFF",
  color: T.text,
  colorScheme: "light",
  fontSize: 15,
};
const primaryBtn: React.CSSProperties = {
  width: "100%",
  minHeight: 48,
  padding: "12px",
  fontSize: 15,
  fontWeight: 700,
  color: "#FFFFFF",
  background: T.primary,
  border: "none",
  borderRadius: T.radius,
  cursor: "pointer",
  marginTop: 14,
};

export default function ShiftSelfRegister({ asSlug }: { asSlug?: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"single" | "bulk">("single");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // single
  const [date, setDate] = useState("");
  const [s1, setS1] = useState("18:00");
  const [e1, setE1] = useState("23:00");

  // bulk
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [s2, setS2] = useState("18:00");
  const [e2, setE2] = useState("23:00");

  const toggleWd = (v: number) =>
    setWeekdays((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));

  const submitSingle = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await saveMyShiftAction({ date, start: s1, end: e1, asSlug });
      setMsg(
        r.ok
          ? { tone: "ok", text: "出勤を登録しました" }
          : { tone: "err", text: reasonMsg[r.reason ?? "error"] ?? "登録できませんでした" },
      );
    } catch {
      setMsg({ tone: "err", text: "通信に失敗しました" });
    } finally {
      setBusy(false);
    }
  };

  const submitBulk = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await saveMyShiftsBulkAction({ rangeStart, rangeEnd, weekdays, start: s2, end: e2, asSlug });
      setMsg(
        r.ok
          ? { tone: "ok", text: `${r.count} 日ぶんの出勤を登録しました` }
          : { tone: "err", text: reasonMsg[r.reason ?? "error"] ?? "登録できませんでした" },
      );
    } catch {
      setMsg({ tone: "err", text: "通信に失敗しました" });
    } finally {
      setBusy(false);
    }
  };

  const tabBtn = (t: "single" | "bulk"): React.CSSProperties => ({
    flex: 1,
    minHeight: 40,
    padding: "8px",
    borderRadius: T.radius,
    border: `1px solid ${T.border}`,
    background: tab === t ? T.primary : "#FFFFFF",
    color: tab === t ? "#FFFFFF" : T.muted,
    fontWeight: 700,
    cursor: "pointer",
  });

  return (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: T.radius, overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: "100%",
          minHeight: 48,
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#FFFFFF",
          border: "none",
          cursor: "pointer",
          color: T.text,
          fontSize: 15,
          fontWeight: 600,
        }}
      >
        <span>出勤を登録</span>
        <span style={{ color: T.muted, fontSize: 13 }}>{open ? "閉じる ▲" : "開く ▼"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 14px 16px", borderTop: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", gap: 8, margin: "14px 0" }}>
            <button type="button" onClick={() => setTab("single")} style={tabBtn("single")}>
              単日
            </button>
            <button type="button" onClick={() => setTab("bulk")} style={tabBtn("bulk")}>
              月・週まとめて
            </button>
          </div>

          {tab === "single" ? (
            <div>
              <label style={label}>日付</label>
              <input style={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>開始</label>
                  <input style={input} type="time" value={s1} onChange={(e) => setS1(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={label}>終了</label>
                  <input style={input} type="time" value={e1} onChange={(e) => setE1(e.target.value)} />
                </div>
              </div>
              <button style={primaryBtn} disabled={busy || !date} onClick={submitSingle}>
                {busy ? "登録中…" : "この日で登録"}
              </button>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>開始日</label>
                  <input style={input} type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={label}>終了日</label>
                  <input style={input} type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
                </div>
              </div>
              <label style={{ ...label, marginTop: 10 }}>曜日</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {WEEKDAYS.map((w) => (
                  <button
                    key={w.v}
                    type="button"
                    onClick={() => toggleWd(w.v)}
                    aria-pressed={weekdays.includes(w.v)}
                    style={{
                      width: 44,
                      minHeight: 44,
                      borderRadius: T.radius,
                      border: `1px solid ${T.border}`,
                      background: weekdays.includes(w.v) ? T.primary : "#FFFFFF",
                      color: weekdays.includes(w.v) ? "#FFFFFF" : T.muted,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>開始</label>
                  <input style={input} type="time" value={s2} onChange={(e) => setS2(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={label}>終了</label>
                  <input style={input} type="time" value={e2} onChange={(e) => setE2(e.target.value)} />
                </div>
              </div>
              <button
                style={primaryBtn}
                disabled={busy || !rangeStart || !rangeEnd || weekdays.length === 0}
                onClick={submitBulk}
              >
                {busy ? "登録中…" : "まとめて登録"}
              </button>
            </div>
          )}

          {msg && (
            <p style={{ marginTop: 12, color: msg.tone === "ok" ? T.primary : T.danger, fontSize: 14 }}>
              {msg.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
