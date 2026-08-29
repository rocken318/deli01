"use client";

/**
 * セラピストプロフィール公開ボタン（掲載同意ゲートつき）。
 * publishTherapistProfile() の結果に応じてゲートメッセージを表示する。
 */

import { useActionState } from "react";
import { publishTherapistProfile } from "@/domain/cms/therapist-actions";
import type { ActionResult } from "@/lib/cms/actions";

interface Props {
  slug: string;
  publishedAt: Date | null;
}

const initialState: ActionResult = { ok: false };

export function TherapistPublishButton({ slug, publishedAt }: Props) {
  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult): Promise<ActionResult> => {
      return publishTherapistProfile(slug);
    },
    initialState,
  );

  const isConsentError =
    state.error?.includes("掲載同意") ?? false;

  return (
    <div className="flex flex-col gap-2">
      {/* 同意ゲートエラー（警告として目立たせる） */}
      {isConsentError && (
        <div
          role="alert"
          className="p-3 text-xs border border-[#C98A2B] text-[#C98A2B] bg-[#C98A2B]/5 rounded"
          style={{ borderRadius: "4px" }}
        >
          <p className="font-medium">公開ブロック</p>
          <p className="mt-0.5">{state.error}</p>
        </div>
      )}

      {/* その他のエラー */}
      {state.error && !isConsentError && (
        <p className="text-xs text-adm-danger">{state.error}</p>
      )}

      {/* 成功メッセージ */}
      {state.ok && (
        <p className="text-xs text-adm-primary">プロフィールを公開しました</p>
      )}

      <div className="flex items-center gap-3">
        <form action={formAction}>
          <button
            type="submit"
            disabled={isPending}
            className="px-5 py-2 text-sm font-medium border border-adm-primary text-adm-primary rounded hover:bg-adm-primary/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ borderRadius: "4px" }}
          >
            {isPending ? "公開中…" : "プロフィールを公開"}
          </button>
        </form>

        {publishedAt && (
          <p className="text-xs text-adm-text/50">
            最終公開: {publishedAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
          </p>
        )}
      </div>
    </div>
  );
}
