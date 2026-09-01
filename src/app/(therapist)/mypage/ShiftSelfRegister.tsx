"use client";

import { useState } from "react";
import { saveMyShiftAction, saveMyShiftsBulkAction } from "@/lib/shifts/self-actions";

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

const box: React.CSSProperties = {
  border: "1px solid #2C343D",
  borderRadius: 8,
  padding: 16,
  background: "#1E252D",
  color: "#EDE9E2",
};
const label: React.CSSProperties = { display: "block", fontSize: 12, color: "#9BA5AF", marginBottom: 4 };
const input: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #2C343D",
  background: "#151A20",
  color: "#EDE9E2",
  colorScheme: "dark",
};
const btn: React.CSSProperties = {
  width: "100%",
  padding: "12px",
  fontSize: 15,
  fontWeight: 700,
  color: "#151A20",
  background: "#C6A15B",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  marginTop: 12,
};

export default function ShiftSelfRegister({ asSlug }: { asSlug?: string }) {
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

  return (
    <div style={box}>
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>出勤を登録</h2>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {(["single", "bulk"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: "8px",
              borderRadius: 6,
              border: "1px solid #2C343D",
              background: tab === t ? "#C6A15B" : "transparent",
              color: tab === t ? "#151A20" : "#9BA5AF",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {t === "single" ? "単日" : "月・週まとめて"}
          </button>
        ))}
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
          <button style={btn} disabled={busy || !date} onClick={submitSingle}>
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
                onClick={() => toggleWd(w.v)}
                style={{
                  width: 40,
                  padding: "8px 0",
                  borderRadius: 6,
                  border: "1px solid #2C343D",
                  background: weekdays.includes(w.v) ? "#5E9E86" : "transparent",
                  color: weekdays.includes(w.v) ? "#151A20" : "#9BA5AF",
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
            style={btn}
            disabled={busy || !rangeStart || !rangeEnd || weekdays.length === 0}
            onClick={submitBulk}
          >
            {busy ? "登録中…" : "まとめて登録"}
          </button>
        </div>
      )}

      {msg && (
        <p style={{ marginTop: 12, color: msg.tone === "ok" ? "#5E9E86" : "#B4453C", fontSize: 14 }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
