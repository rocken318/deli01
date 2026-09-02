"use client";

/**
 * 案内表コンソールのタブ切替（板 ↔ 時系列）。
 * 新規ページを作らず、既存の配車ボードを「時系列」タブとして同一URLに載せる（判断 Q2）。
 * board / timeline はサーバで描画済みのノードを受け取り、クライアントで表示だけ切り替える。
 */

import { useState } from "react";

type Tab = "board" | "timeline";

const tabBtn = (active: boolean): React.CSSProperties => ({
  appearance: "none",
  border: "1px solid #DFE3DE",
  borderBottom: active ? "1px solid #F6F7F5" : "1px solid #DFE3DE",
  background: active ? "#F6F7F5" : "#EDEFEC",
  color: active ? "#1C2321" : "#6B7776",
  fontWeight: 700,
  fontSize: 13,
  padding: "7px 16px",
  borderRadius: "8px 8px 0 0",
  marginBottom: -1,
  cursor: "pointer",
});

export default function ConsoleTabs({
  board,
  timeline,
}: {
  board: React.ReactNode;
  timeline: React.ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("board");
  return (
    <div>
      <div role="tablist" style={{ display: "flex", gap: 4, borderBottom: "1px solid #DFE3DE", marginBottom: 12 }}>
        <button role="tab" aria-selected={tab === "board"} style={tabBtn(tab === "board")} onClick={() => setTab("board")}>
          板（次案内可能）
        </button>
        <button role="tab" aria-selected={tab === "timeline"} style={tabBtn(tab === "timeline")} onClick={() => setTab("timeline")}>
          時系列（配車）
        </button>
      </div>
      <div role="tabpanel" hidden={tab !== "board"}>
        {board}
      </div>
      <div role="tabpanel" hidden={tab !== "timeline"}>
        {timeline}
      </div>
    </div>
  );
}
