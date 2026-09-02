"use client";

import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { settleReservation } from "@/lib/annai/checkpoint-actions";

const TZ = "Asia/Tokyo";
const yen = (n: number) => `¥${n.toLocaleString()}`;

export default function SettlePanel({
  reservationId,
  status,
  totalAmount,
  collectedAmount,
  reconciledAtISO,
  isCard,
  settleNote,
}: {
  reservationId: string;
  status: string;
  totalAmount: number;
  collectedAmount: number | null;
  reconciledAtISO: string | null;
  isCard: boolean;
  settleNote: string | null;
}) {
  const [settled, setSettled] = useState<{ collected: number; diff: number; card: boolean; at: string; note: string | null } | null>(
    reconciledAtISO !== null && collectedAmount !== null
      ? { collected: collectedAmount, diff: collectedAmount - totalAmount, card: isCard, at: reconciledAtISO, note: settleNote }
      : null,
  );
  const [amount, setAmount] = useState(String(totalAmount));
  const [card, setCard] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (status !== "done") {
    return <p style={{ color: "#6B7776", fontSize: 13 }}>退勤済み（完了）の予約のみ清算できます。</p>;
  }

  if (settled) {
    const diffColor = settled.diff === 0 ? "#3F7A6B" : "#B4453C";
    return (
      <div style={{ fontSize: 14 }}>
        <div>総額 {yen(totalAmount)} / 回収 <b>{yen(settled.collected)}</b>{" "}
          <span style={{ color: diffColor, fontWeight: 700 }}>
            {settled.diff === 0 ? "✓ 一致" : `差額 ${settled.diff > 0 ? "+" : ""}${yen(settled.diff)}`}
          </span>
        </div>
        <div style={{ color: "#6B7776", fontSize: 12, marginTop: 4 }}>
          決済: {settled.card ? "カード" : "現金"} / 清算済み {formatInTimeZone(new Date(settled.at), TZ, "yyyy-MM-dd HH:mm")}
        </div>
        {settled.note && <div style={{ color: "#8a5d16", fontSize: 12, marginTop: 4 }}>メモ: {settled.note}</div>}
        {settled.card && (
          <div style={{ color: "#6B7776", fontSize: 12, marginTop: 4 }}>
            決済URL: <span style={{ background: "#F3F7F5", border: "1px dashed #DFE3DE", borderRadius: 4, padding: "1px 8px" }}>未発行（決済連携待ち）</span>
          </div>
        )}
      </div>
    );
  }

  const collected = Number(amount) || 0;
  const diff = collected - totalAmount;

  return (
    <div style={{ fontSize: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span>総額 <b>{yen(totalAmount)}</b></span>
        <label style={{ fontSize: 12, color: "#6B7776" }}>
          回収額{" "}
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric"
            style={{ width: 90, border: "1px solid #DFE3DE", borderRadius: 4, padding: "5px 8px", fontSize: 14 }} />
        </label>
        <span style={{ color: diff === 0 ? "#3F7A6B" : "#B4453C", fontWeight: 700 }}>
          {diff === 0 ? "✓ 一致" : `差額 ${diff > 0 ? "+" : ""}${yen(diff)}`}
        </span>
        <label style={{ fontSize: 13, color: "#1C2321", cursor: "pointer" }}>
          <input type="checkbox" checked={card} onChange={(e) => setCard(e.target.checked)} /> カード決済
        </label>
      </div>
      {diff !== 0 && (
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="差額の理由（必須）"
          style={{ width: "100%", boxSizing: "border-box", border: "2px solid #C98A2B", borderRadius: 4, padding: "6px 8px", fontSize: 13, marginTop: 8 }} />
      )}
      {card && (
        <div style={{ color: "#8a5d16", fontSize: 12, marginTop: 6 }}>
          決済URL: 未発行（決済連携待ち・オンライン決済はv1対象外）
        </div>
      )}
      <button
        type="button"
        disabled={busy || (diff !== 0 && note.trim().length === 0)}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            const r = await settleReservation({ reservationId, collectedAmount: collected, isCard: card, note });
            if (r.ok) setSettled({ collected: r.data.collectedAmount, diff: r.data.diff, card, at: r.data.reconciledAt, note: note.trim() || null });
            else setErr(r.error);
          } catch {
            setErr("通信に失敗しました");
          } finally {
            setBusy(false);
          }
        }}
        style={{ marginTop: 10, background: "#C98A2B", color: "#fff", border: "none", borderRadius: 4, padding: "8px 18px", fontSize: 14, fontWeight: 800, cursor: "pointer" }}
      >
        {busy ? "清算中…" : "照合OKで清算を締める"}
      </button>
      {err && <p style={{ color: "#B4453C", fontSize: 12, marginTop: 6 }}>{err}</p>}
    </div>
  );
}
