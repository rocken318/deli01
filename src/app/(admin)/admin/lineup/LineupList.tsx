"use client";

/**
 * 表ページ（公開トップ）の「すぐ迎えるセラピスト」並び順を入れ替える UI。
 * 上下ボタンで並べ替え、移動のたびに全体を 10 刻みで再採番して
 * updateTherapistOrder に一括保存する（重複 display_order でも確実に反映）。
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTherapistOrder } from "@/domain/cms/therapist-actions";

export interface LineupRow {
  id: string;
  slug: string;
  name: string;
  /** 「本日 20:00〜」「明日 15:00〜」「本日の出勤なし」等。null は調整中 */
  earliestLabel: string | null;
  /** すぐ迎えられる（本日枠あり）か。強調表示に使う */
  soon: boolean;
}

export default function LineupList({ initial }: { initial: LineupRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<LineupRow[]>(initial);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const move = (index: number, dir: "up" | "down") => {
    const target = dir === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setRows(next);
    setError(null);
    startTransition(async () => {
      const items = next.map((r, i) => ({ id: r.id, displayOrder: (i + 1) * 10 }));
      const res = await updateTherapistOrder(items);
      if (!res.ok) {
        setError(res.error ?? "並び順の保存に失敗しました");
        setRows(initial); // 失敗時は元に戻す
      } else {
        router.refresh();
      }
    });
  };

  if (rows.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-adm-text/60">
        <p>表ページに出るセラピストがいません。</p>
        <p className="mt-1">セラピストを公開すると、ここに並びます。</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div
          role="alert"
          className="p-3 border border-adm-danger text-adm-danger text-sm"
          style={{ borderRadius: "4px" }}
        >
          {error}
        </div>
      )}
      <ol className="border border-adm-border overflow-hidden" style={{ borderRadius: "4px" }}>
        {rows.map((r, i) => (
          <li
            key={r.id}
            className="flex items-center gap-3 px-4 py-3 border-b border-adm-border last:border-0 bg-adm-surface"
          >
            <span className="w-6 shrink-0 text-center text-adm-text/50 tabular-nums">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-adm-text truncate">{r.name}</span>
                {r.soon ? (
                  <span
                    className="shrink-0 text-xs px-2 py-0.5 bg-[#3F7A6B]/10 text-[#3F7A6B] border border-[#3F7A6B]/20"
                    style={{ borderRadius: "4px" }}
                  >
                    すぐ迎える
                  </span>
                ) : null}
                <span className="shrink-0 text-xs text-adm-text/40 font-mono">{r.slug}</span>
              </div>
              <div className="text-xs text-adm-text/60 mt-0.5">
                {r.earliestLabel ?? "案内時間は調整中"}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => move(i, "up")}
                disabled={i === 0 || isPending}
                aria-label={`${r.name} を上へ`}
                className="p-1.5 border border-adm-border text-adm-text/50 hover:text-adm-primary hover:border-adm-primary disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ borderRadius: "4px" }}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, "down")}
                disabled={i === rows.length - 1 || isPending}
                aria-label={`${r.name} を下へ`}
                className="p-1.5 border border-adm-border text-adm-text/50 hover:text-adm-primary hover:border-adm-primary disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ borderRadius: "4px" }}
              >
                ↓
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
