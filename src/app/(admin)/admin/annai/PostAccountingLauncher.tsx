"use client";

/**
 * 案内表の手動「計上」ボタン。完了(done)だが未計上の予約を会計台帳へ計上する。
 * 通常は完了時に自動計上されるが、その保険として案内表からも押せるようにする（発注者要望）。
 * postReservationAccounting は冪等（既計上は成功扱い）。
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { postReservationAccounting } from "@/lib/accounting/actions";

export default function PostAccountingLauncher({ reservationIds }: { reservationIds: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const post = async () => {
    setBusy(true);
    setErr(null);
    let failed: string | null = null;
    for (const id of reservationIds) {
      const r = await postReservationAccounting(id);
      if (!r.ok) failed = r.error ?? "計上に失敗しました";
    }
    setBusy(false);
    setErr(failed);
    if (!failed) startTransition(() => router.refresh());
  };

  return (
    <>
      <button
        type="button"
        onClick={post}
        disabled={busy || pending}
        style={{
          background: "#C98A2B",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          padding: "1px 8px",
          fontSize: 11,
          marginLeft: 4,
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy || pending ? "計上中…" : `未計上${reservationIds.length}件を計上`}
      </button>
      {err && <span style={{ color: "#B4453C", fontSize: 11, marginLeft: 4 }}>{err}</span>}
    </>
  );
}
