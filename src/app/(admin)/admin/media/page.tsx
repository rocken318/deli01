import type { Metadata } from "next";

export const dynamic = "force-dynamic";

import { listMedia, upsertMediaMeta } from "@/lib/cms/media-actions";

export const metadata: Metadata = { title: "メディア" };

export default async function MediaPage() {
  const items = await listMedia();

  async function handleUpdateMeta(formData: FormData) {
    "use server";
    const id = formData.get("id") as string;
    const alt = formData.get("alt") as string;
    const tagsRaw = formData.get("tags") as string;
    const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
    await upsertMediaMeta({
      id,
      alt,
      tags,
      storagePath: formData.get("storagePath") as string ?? "",
      url: formData.get("url") as string ?? "",
      mime: "image/webp",
      consentFlag: false,
      faceVisibility: "none",
      isPlaceholder: false,
    });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-adm-text">メディアライブラリ</h1>

      {items.length === 0 ? (
        <div className="bg-adm-surface border border-adm-border rounded p-6">
          <p className="text-sm text-adm-text opacity-60">メディアがありません</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="bg-adm-surface border border-adm-border rounded p-4"
            >
              <div className="flex items-start gap-4">
                {/* サムネイル or プレースホルダー */}
                <div className="w-16 h-16 bg-adm-bg border border-adm-border rounded flex items-center justify-center shrink-0">
                  {item.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.url} alt={item.alt} className="w-full h-full object-cover rounded" />
                  ) : (
                    <span className="text-xs text-adm-text opacity-40">なし</span>
                  )}
                </div>

                {/* 編集フォーム */}
                <form action={handleUpdateMeta} className="flex-1 space-y-2">
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="storagePath" value={item.isPlaceholder ? "" : ""} />
                  <input type="hidden" name="url" value={item.url} />

                  <div className="flex items-center gap-2">
                    <label htmlFor={`alt-${item.id}`} className="w-20 text-xs text-adm-text shrink-0">
                      alt テキスト
                    </label>
                    <input
                      id={`alt-${item.id}`}
                      name="alt"
                      defaultValue={item.alt}
                      required
                      className="flex-1 border border-adm-border rounded px-2 py-1 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <label htmlFor={`tags-${item.id}`} className="w-20 text-xs text-adm-text shrink-0">
                      タグ
                    </label>
                    <input
                      id={`tags-${item.id}`}
                      name="tags"
                      defaultValue={item.tags.join(", ")}
                      placeholder="カンマ区切り（例: hero, placeholder）"
                      className="flex-1 border border-adm-border rounded px-2 py-1 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs text-adm-text opacity-60">
                      {item.isPlaceholder && (
                        <span className="px-1.5 py-0.5 bg-adm-caution text-white rounded text-xs">
                          仮
                        </span>
                      )}
                      {item.consentFlag && (
                        <span className="px-1.5 py-0.5 bg-adm-primary text-white rounded text-xs">
                          同意済
                        </span>
                      )}
                      <span className="font-mono">{item.id.slice(0, 8)}…</span>
                    </div>
                    <button
                      type="submit"
                      className="px-3 py-1 text-xs bg-adm-primary text-white rounded hover:opacity-90"
                    >
                      保存
                    </button>
                  </div>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
