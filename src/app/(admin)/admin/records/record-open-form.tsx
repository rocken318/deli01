"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * slug を入力して /admin/records/[entity]/[slug] へ遷移する。
 * GET フォームでは path セグメントを組めない（?slug= になり 404）ため、
 * クライアントで URL を組んで push する。
 */
export function RecordOpenForm({ entity }: { entity: string }) {
  const router = useRouter();
  const [slug, setSlug] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const s = slug.trim();
        if (s) router.push(`/admin/records/${entity}/${encodeURIComponent(s)}`);
      }}
      className="flex gap-2"
    >
      <input
        name="slug"
        type="text"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        placeholder="slug（例: demo-therapist-01）"
        required
        pattern="[a-z0-9-]+"
        title="小文字英数字とハイフンのみ"
        className="flex-1 px-3 py-1.5 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary"
        style={{ borderRadius: "4px" }}
      />
      <button
        type="submit"
        className="px-3 py-1.5 text-sm bg-adm-primary text-white rounded hover:bg-adm-primary/90 transition-colors"
        style={{ borderRadius: "4px" }}
      >
        開く
      </button>
    </form>
  );
}
