"use client";

/**
 * 公開ボタン + 禁止語警告表示（クライアントコンポーネント / spec 13-2）。
 * publishPage の戻り値 warnings を受け取り、role=alert で運営者に表示する。
 * 公開自体はブロックしない（警告のみ）。
 */

import { useActionState } from "react";
import type { ActionResult } from "@/lib/cms/actions";
import type { PublishPageResult } from "@/lib/cms/pages-actions";

interface Props {
  action: (
    prev: ActionResult<PublishPageResult>,
    formData: FormData,
  ) => Promise<ActionResult<PublishPageResult>>;
}

const initialState: ActionResult<PublishPageResult> = { ok: false };

export function PublishForm({ action }: Props) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <div className="space-y-4">
      {/* 公開エラー */}
      {!state.ok && state.error && (
        <div
          role="alert"
          className="p-3 text-sm border border-adm-danger text-adm-danger rounded"
        >
          公開に失敗しました: {state.error}
        </div>
      )}

      {/* 公開成功 + 禁止語警告（spec 13-2） */}
      {state.ok && state.data && (
        <>
          <div
            role="status"
            className="p-3 text-sm border border-adm-primary text-adm-primary rounded"
          >
            公開しました。
          </div>
          {state.data.warnings.length > 0 && (
            <div
              role="alert"
              className="p-3 text-sm border border-adm-caution text-adm-caution rounded space-y-1"
            >
              <p className="font-medium">
                禁止語の警告（公開はされましたが確認してください / spec 13-2）
              </p>
              <ul className="list-disc pl-5">
                {state.data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          className="px-6 py-2 text-sm bg-adm-primary text-white rounded hover:opacity-90 font-medium disabled:opacity-50"
        >
          {isPending ? "公開中…" : "このページを公開する"}
        </button>
        <p className="mt-2 text-xs text-adm-text opacity-60">
          公開すると draft の内容が published に反映されます。禁止語チェックは警告のみ（ブロックしません）。
        </p>
      </form>
    </div>
  );
}
