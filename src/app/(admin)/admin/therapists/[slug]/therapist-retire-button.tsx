"use client";

/**
 * セラピスト退職ボタン（危険操作）。
 * クリック → 確認ダイアログ → retireTherapist() を実行する。
 * 退職処理はプロフィール非公開・関連メディア一括 is_hidden=true を含む。
 */

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { retireTherapist } from "@/domain/cms/therapist-actions";
import type { ActionResult } from "@/lib/cms/actions";

interface Props {
  slug: string;
}

const initialState: ActionResult = { ok: false };

export function TherapistRetireButton({ slug }: Props) {
  const router = useRouter();

  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult): Promise<ActionResult> => {
      const confirmed = window.confirm(
        `「${slug}」を退職処理しますか？\n\nこの操作を実行すると:\n・ステータスが「退職」になります\n・公開プロフィールが非公開になります\n・関連する写真がすべて非公開になります\n\nこの操作は取り消せません。`,
      );
      if (!confirmed) return { ok: false };

      const result = await retireTherapist(slug);
      if (result.ok) {
        router.refresh();
      }
      return result;
    },
    initialState,
  );

  return (
    <div>
      {state.error && (
        <p className="text-xs text-adm-danger mb-2">{state.error}</p>
      )}
      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm border border-adm-danger text-adm-danger rounded hover:bg-adm-danger/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          style={{ borderRadius: "4px" }}
        >
          {isPending ? "処理中…" : "退職処理"}
        </button>
      </form>
    </div>
  );
}
