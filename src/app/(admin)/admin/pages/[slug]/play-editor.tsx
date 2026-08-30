"use client";

/**
 * 「プレイ内容」エディタ（管理側 / spec 12-2）。
 * 見出し＋各プレイの内容枠を編集し、＋ボタンでプレイを追加、×で削除する。
 * 保存は savePlayBlock（draft へ）。公開は既存の「このページを公開する」ボタンで反映。
 * 管理側なので日本語直書き可（公開側の直書き禁止は対象外）。
 */

import { useState, useTransition } from "react";
import { savePlayBlock } from "@/lib/cms/pages-actions";

interface Props {
  slug: string;
  initialHeading: string;
  initialItems: { body: string }[];
}

export function PlayEditor({ slug, initialHeading, initialItems }: Props) {
  const [heading, setHeading] = useState(initialHeading);
  const [items, setItems] = useState<{ body: string }[]>(
    initialItems.length > 0 ? initialItems : [{ body: "" }],
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function updateItem(index: number, body: string) {
    setItems((prev) => prev.map((it, i) => (i === index ? { body } : it)));
  }
  function addItem() {
    setItems((prev) => [...prev, { body: "" }]);
  }
  function removeItem(index: number) {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await savePlayBlock(slug, { heading, items });
      setMessage(
        result.ok
          ? { ok: true, text: "保存しました（公開ボタンで反映されます）" }
          : { ok: false, text: result.error ?? "保存に失敗しました" },
      );
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <label htmlFor="play-heading" className="w-40 text-sm text-adm-text shrink-0 pt-1.5">
          セクション見出し
        </label>
        <input
          id="play-heading"
          value={heading}
          onChange={(e) => setHeading(e.target.value)}
          placeholder="プレイ内容"
          className="flex-1 border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
        />
      </div>

      <ol className="space-y-3">
        {items.map((item, i) => (
          <li key={i} className="rounded border border-adm-border bg-adm-bg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-adm-primary">プレイ{i + 1}</span>
              <button
                type="button"
                onClick={() => removeItem(i)}
                disabled={items.length <= 1}
                className="text-xs text-adm-danger hover:opacity-80 disabled:opacity-40"
              >
                × 削除
              </button>
            </div>
            <textarea
              value={item.body}
              onChange={(e) => updateItem(i, e.target.value)}
              rows={3}
              placeholder="内容を入力"
              className="w-full border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-surface text-adm-text focus:outline-none focus:border-adm-primary resize-none"
            />
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={addItem}
          className="px-3 py-1.5 text-sm border border-adm-border rounded text-adm-text hover:border-adm-primary hover:text-adm-primary"
        >
          ＋ プレイを追加
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="px-4 py-2 text-sm bg-adm-primary text-white rounded hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "保存中…" : "プレイ内容を保存"}
        </button>
      </div>

      {message && (
        <div
          role={message.ok ? "status" : "alert"}
          className={`p-3 text-sm border rounded ${
            message.ok
              ? "border-adm-primary text-adm-primary"
              : "border-adm-danger text-adm-danger"
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
