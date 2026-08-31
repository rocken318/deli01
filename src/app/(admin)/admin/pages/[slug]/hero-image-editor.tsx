"use client";

import { useState, useTransition } from "react";
import {
  MediaPicker,
  type MediaPickerItem,
} from "@/app/(admin)/_components/media-picker";
import { savePageHeroImage } from "@/lib/cms/pages-actions";

/**
 * ヒーロー画像の編集（アップロード＋選択を内蔵）。
 * 以前はメディア一覧で url を用意→ここで id を select、と分かれていたのを1箇所に。
 */
export function HeroImageEditor({
  slug,
  initialImageId,
  initialMedia,
}: {
  slug: string;
  initialImageId: string | null;
  initialMedia: MediaPickerItem[];
}) {
  const [imageId, setImageId] = useState<string | null>(initialImageId);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setMsg(null);
    start(async () => {
      const r = await savePageHeroImage(slug, imageId);
      setMsg(
        r.ok
          ? { ok: true, text: "保存しました（「このページを公開する」で反映）" }
          : { ok: false, text: r.error ?? "保存に失敗しました" },
      );
    });
  }

  return (
    <div className="space-y-3">
      <MediaPicker value={imageId} onChange={setImageId} initialMedia={initialMedia} />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded bg-adm-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "保存中…" : "ヒーロー画像を保存"}
        </button>
        {msg && (
          <span className={`text-xs ${msg.ok ? "text-adm-primary" : "text-adm-danger"}`}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
