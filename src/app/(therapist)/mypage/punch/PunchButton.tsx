"use client";

import { useState } from "react";
import { punchAttendanceAction } from "@/lib/attendance/actions";

export default function PunchButton({
  token,
  asSlug,
  action,
}: {
  token: string;
  asSlug?: string;
  action: "clock_in" | "clock_out";
}) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  const onClick = async () => {
    setState("sending");
    const r = await punchAttendanceAction({ token, asSlug });
    if (r.ok) {
      setState("done");
      setMsg(
        r.action === "clock_in" ? "出勤を記録しました" : "退勤を記録しました。おつかれさまでした",
      );
    } else {
      setState("error");
      setMsg(
        r.reason === "expired"
          ? "QRの有効期限が切れました。事務所の画面を撮り直してください"
          : r.reason === "already_done"
            ? "本日はすでに退勤済みです"
            : "記録できませんでした",
      );
    }
  };

  if (state === "done") return <p style={{ color: "#2c6152", fontSize: 16 }}>✓ {msg}</p>;

  return (
    <div>
      <button
        onClick={onClick}
        disabled={state === "sending"}
        style={{
          width: "100%",
          padding: "16px",
          fontSize: 18,
          fontWeight: 700,
          color: "#fff",
          background: action === "clock_in" ? "#3F7A6B" : "#C98A2B",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
        }}
      >
        {state === "sending" ? "記録中…" : action === "clock_in" ? "出勤" : "退勤"}
      </button>
      {state === "error" && <p style={{ color: "#B4453C", marginTop: 12 }}>{msg}</p>}
    </div>
  );
}
