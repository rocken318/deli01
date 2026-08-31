"use server";

import { put } from "@vercel/blob";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { getDevSession } from "@/lib/cms/dev-session";
import { upsertMediaMeta } from "@/lib/cms/media-actions";
import type { ActionResult } from "@/lib/cms/actions";

/**
 * 画像を Vercel Blob にアップロードし、media レコードを作成する。
 * ＝これまで url を手入力するしかなかった（Storage 未配線）画像アップロードの実配線。
 * 4.5MB を超えるファイルはサーバレスのボディ上限に当たるため弾く（超える場合は縮小案内）。
 */
export async function uploadMedia(
  formData: FormData,
): Promise<ActionResult<{ id: string; url: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_cms")) {
    return { ok: false, error: "権限がありません" };
  }

  const file = formData.get("file");
  const alt = (formData.get("alt") as string | null)?.trim() || "";
  const faceRaw = (formData.get("face_visibility") as string | null) ?? "face";
  const faceVisibility =
    faceRaw === "eyes" || faceRaw === "none" ? faceRaw : "face";

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "ファイルが選択されていません" };
  }
  if (!file.type.startsWith("image/")) {
    return { ok: false, error: "画像ファイルを選んでください" };
  }
  if (file.size > 4.5 * 1024 * 1024) {
    return {
      ok: false,
      error: "画像が大きすぎます（4.5MB以下に縮小してください）",
    };
  }
  // 接続済み Blob ストア（BLOB_STORE_ID）か明示トークンのどちらかがあれば put できる
  //（新しい統合はトークンを env に出さず、接続ストア＋OIDC/実行時注入で認証する）。
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    return {
      ok: false,
      error:
        "画像ストレージ（Vercel Blob）が未設定です。Vercel の Storage で Blob を作成してください。",
    };
  }

  try {
    const blob = await put(`media/${file.name}`, file, {
      access: "public",
      addRandomSuffix: true,
      contentType: file.type,
    });
    const res = await upsertMediaMeta({
      url: blob.url,
      storagePath: blob.pathname,
      mime: file.type,
      alt: alt || file.name,
      tags: ["upload"],
      faceVisibility,
      consentFlag: true,
      isPlaceholder: false,
    });
    if (!res.ok || !res.data) {
      return { ok: false, error: res.error ?? "メディア登録に失敗しました" };
    }
    return { ok: true, data: { id: res.data.id, url: blob.url } };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "アップロードに失敗しました",
    };
  }
}
