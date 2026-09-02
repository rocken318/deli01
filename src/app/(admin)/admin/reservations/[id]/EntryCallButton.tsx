"use client";

import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { recordEntryCall } from "@/lib/annai/checkpoint-actions";

const TZ = "Asia/Tokyo";

export default function EntryCallButton({
  reservationId,
  entryCallAtISO,
  active,
}: {
  reservationId: string;
  entryCallAtISO: string | null;
  active: boolean; // confirmed/enroute/in_service/done のとき true
}) {
  const [done, setDone] = useState(entryCallAtISO);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (done) {
    return <span style={{ color: "#3F7A6B", fontSize: 13 }}>受付済み（{formatInTimeZone(new Date(done), TZ, "HH:mm")}）</span>;
  }
  if (!active) return <span style={{ color: "#6B7776", fontSize: 13 }}>—</span>;

  return (
    <span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            const r = await recordEntryCall(reservationId);
            if (r.ok) setDone(r.at);
            else setErr(r.error);
          } catch {
            setErr("記録に失敗しました");
          } finally {
            setBusy(false);
          }
        }}
        style={{ background: "#3F7A6B", color: "#fff", border: "none", borderRadius: 4, padding: "5px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
      >
        {busy ? "記録中…" : "入室連絡を記録"}
      </button>
      {err && <span style={{ color: "#B4453C", fontSize: 12, marginLeft: 8 }}>{err}</span>}
    </span>
  );
}
