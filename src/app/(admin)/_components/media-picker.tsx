"use client";

import { useState, useTransition } from "react";
import { uploadMedia } from "@/lib/cms/blob-actions";

export interface MediaPickerItem {
  id: string;
  url: string;
  alt: string;
}

/**
 * 画像の「アップロード＋既存から選択」を1箇所で行う再利用コンポーネント。
 * これまでメディアアップロードと編集画面が分かれていた課題の解消に使う。
 * value=選択中の media id（null=未選択）。onChange で親に返す。
 * 管理側なので日本語直書き可。
 */
export function MediaPicker({
  value,
  onChange,
  initialMedia,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  initialMedia: MediaPickerItem[];
}) {
  const [media, setMedia] = useState<MediaPickerItem[]>(initialMedia);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    fd.set("alt", file.name);
    setMsg(null);
    start(async () => {
      const r = await uploadMedia(fd);
      if (r.ok && r.data) {
        const item: MediaPickerItem = { id: r.data.id, url: r.data.url, alt: file.name };
        setMedia((m) => [item, ...m]);
        onChange(r.data.id);
        setMsg({ ok: true, text: "アップロードして選択しました" });
      } else {
        setMsg({ ok: false, text: r.error ?? "アップロードに失敗しました" });
      }
    });
    e.target.value = "";
  }

  const selected = media.find((m) => m.id === value) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="h-20 w-20 shrink-0 overflow-hidden rounded border border-adm-border bg-adm-bg">
          {selected ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selected.url} alt={selected.alt} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-adm-text/40">
              未選択
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <label className="inline-flex cursor-pointer items-center rounded border border-adm-border px-3 py-1.5 text-sm text-adm-text hover:bg-adm-bg">
            {pending ? "アップロード中…" : "＋ 画像をアップロード"}
            <input
              type="file"
              accept="image/*"
              onChange={handleFile}
              disabled={pending}
              className="hidden"
            />
          </label>
          {value && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-left text-xs text-adm-danger hover:opacity-80"
            >
              × 選択を外す
            </button>
          )}
        </div>
      </div>

      {msg && (
        <p className={`text-xs ${msg.ok ? "text-adm-primary" : "text-adm-danger"}`}>
          {msg.text}
        </p>
      )}

      {media.length > 0 && (
        <div className="grid max-h-56 grid-cols-5 gap-2 overflow-y-auto rounded border border-adm-border p-2">
          {media.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onChange(m.id)}
              title={m.alt}
              className={`aspect-square overflow-hidden rounded border-2 ${
                value === m.id ? "border-adm-primary" : "border-transparent hover:border-adm-border"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.url} alt={m.alt} className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
