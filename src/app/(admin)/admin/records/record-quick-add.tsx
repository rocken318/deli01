"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createEntityRecordByName } from "@/lib/cms/actions";

/**
 * 名前だけでコンテンツを新規作成する（slug はサーバーが自動採番）。
 * 作成後はその編集フォームへ遷移し、残りの項目を埋めてもらう（#2 直感UX）。
 */
export function RecordQuickAdd({ entity }: { entity: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const result = await createEntityRecordByName(entity, trimmed);
      if (result.ok && result.data) {
        router.push(`/admin/records/${entity}/${encodeURIComponent(result.data.slug)}`);
      } else {
        setError(result.error ?? "作成に失敗しました");
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="名前を入力して追加（例: 新しいセラピスト）"
        disabled={pending}
        className="flex-1 px-3 py-1.5 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary disabled:opacity-50"
        style={{ borderRadius: "4px" }}
      />
      <button
        type="submit"
        disabled={pending || name.trim().length === 0}
        className="px-3 py-1.5 text-sm bg-adm-primary text-white rounded hover:bg-adm-primary/90 transition-colors disabled:opacity-50"
        style={{ borderRadius: "4px" }}
      >
        {pending ? "追加中…" : "追加"}
      </button>
      {error && (
        <span role="alert" className="self-center text-xs text-adm-danger">
          {error}
        </span>
      )}
    </form>
  );
}
