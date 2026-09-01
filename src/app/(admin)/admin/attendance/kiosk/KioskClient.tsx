"use client";

import { useEffect, useState } from "react";
import { issueKioskToken } from "@/lib/attendance/actions";

export default function KioskClient() {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await issueKioskToken();
      if (!alive) return;
      if (r.ok && r.svg) {
        setSvg(r.svg);
        setErr(null);
      } else {
        setErr(r.reason ?? "error");
      }
    };
    void tick();
    const id = setInterval(tick, 45_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (err === "no_secret") {
    return (
      <div style={{ color: "#B4453C", fontSize: 14 }}>
        ATTENDANCE_QR_SECRET が未設定です。環境変数を設定するとQRを発行します。
      </div>
    );
  }
  if (err) return <div style={{ color: "#B4453C" }}>発行に失敗しました（{err}）。</div>;
  if (!svg) return <div style={{ color: "#5b625f" }}>QRを生成中…</div>;

  return (
    <div
      aria-label="出退勤QRコード"
      style={{ width: 320, height: 320 }}
      // qrToString の出力（自社サーバ生成の信頼できるSVG）
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
