"use client";

/**
 * セラピスト内部情報フォーム（クライアントコンポーネント）。
 * status / display_order / app_user_id（紐付け）を編集する。
 * 新規作成（therapist=null）と編集の両方に対応する。
 */

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { upsertTherapist } from "@/domain/cms/therapist-actions";
import type { ActionResult } from "@/lib/cms/actions";
import type { TherapistListItem } from "@/domain/cms/therapist-actions";

interface Props {
  therapist: TherapistListItem | null;
}

const initialState: ActionResult<{ id: string }> = { ok: false };

export function TherapistInternalForm({ therapist }: Props) {
  const router = useRouter();

  const [state, formAction, isPending] = useActionState(
    async (
      _prev: ActionResult<{ id: string }>,
      formData: FormData,
    ): Promise<ActionResult<{ id: string }>> => {
      const slug = formData.get("slug");
      const status = formData.get("status");
      const displayOrder = formData.get("display_order");
      const appUserId = formData.get("app_user_id");

      const result = await upsertTherapist({
        slug: typeof slug === "string" ? slug : "",
        status: (status as "active" | "inactive" | "retired") ?? "active",
        displayOrder: displayOrder ? Number(displayOrder) : 0,
        appUserId: typeof appUserId === "string" && appUserId.trim().length > 0
          ? appUserId.trim()
          : null,
      });

      if (result.ok && !therapist) {
        // 新規作成後は詳細ページへリダイレクト
        const slugVal = typeof slug === "string" ? slug : "";
        router.push(`/admin/therapists/${slugVal}`);
      }

      return result;
    },
    initialState,
  );

  const baseInputClass =
    "w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary";
  const baseStyle = { borderRadius: "4px" };

  return (
    <form action={formAction} className="space-y-4">
      {/* エラー / 成功メッセージ */}
      {state.error && (
        <div
          role="alert"
          className="p-3 text-sm border border-adm-danger text-adm-danger rounded"
          style={baseStyle}
        >
          {state.error}
        </div>
      )}
      {state.ok && state.data && (
        <div
          role="status"
          className="p-3 text-sm border border-adm-primary text-adm-primary rounded"
          style={baseStyle}
        >
          保存しました
        </div>
      )}

      {/* slug（新規時のみ編集可） */}
      <div>
        <label htmlFor="slug" className="block text-sm font-medium text-adm-text mb-1">
          slug
          <span className="ml-1 text-adm-danger text-xs">*</span>
          {therapist && (
            <span className="ml-2 text-xs font-normal text-adm-text/50">（変更不可）</span>
          )}
        </label>
        <input
          id="slug"
          name="slug"
          type="text"
          defaultValue={therapist?.slug ?? ""}
          required
          readOnly={!!therapist}
          pattern="[a-z0-9-]+"
          placeholder="例: aoi"
          className={`${baseInputClass} ${therapist ? "bg-adm-bg cursor-not-allowed text-adm-text/60" : ""}`}
          style={baseStyle}
        />
        <p className="text-xs text-adm-text/50 mt-1">小文字英数字とハイフンのみ（例: aoi / tanaka-yuki）</p>
      </div>

      {/* status */}
      <div>
        <label htmlFor="status" className="block text-sm font-medium text-adm-text mb-1">
          ステータス
        </label>
        <select
          id="status"
          name="status"
          defaultValue={therapist?.status ?? "active"}
          className={baseInputClass}
          style={baseStyle}
        >
          <option value="active">稼働中</option>
          <option value="inactive">非稼働</option>
          <option value="retired">退職</option>
        </select>
      </div>

      {/* display_order */}
      <div>
        <label htmlFor="display_order" className="block text-sm font-medium text-adm-text mb-1">
          表示順
        </label>
        <input
          id="display_order"
          name="display_order"
          type="number"
          step="1"
          defaultValue={therapist?.displayOrder ?? 0}
          className={baseInputClass}
          style={baseStyle}
          placeholder="0"
        />
        <p className="text-xs text-adm-text/50 mt-1">小さい数値が先に表示されます</p>
      </div>

      {/* app_user_id（任意） */}
      <div>
        <label htmlFor="app_user_id" className="block text-sm font-medium text-adm-text mb-1">
          アプリユーザー ID（任意）
        </label>
        <input
          id="app_user_id"
          name="app_user_id"
          type="text"
          defaultValue={therapist?.appUserId ?? ""}
          placeholder="app_users.id（UUID）"
          className={baseInputClass}
          style={baseStyle}
        />
        <p className="text-xs text-adm-text/50 mt-1">
          app_users テーブルの UUID を入力すると、そのユーザーとセラピストを紐付けます
        </p>
      </div>

      {/* 保存ボタン */}
      <div className="flex items-center gap-3 pt-4 border-t border-adm-border">
        <button
          type="submit"
          disabled={isPending}
          className="px-5 py-2 text-sm font-medium bg-adm-primary text-white rounded hover:bg-adm-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          style={baseStyle}
        >
          {isPending ? "保存中…" : (therapist ? "内部情報を更新" : "セラピストを作成")}
        </button>
      </div>
    </form>
  );
}
