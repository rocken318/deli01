"use client";

/**
 * フィールド追加フォーム（クライアントコンポーネント / spec 3-1）。
 * Server Action addFieldDefinition を呼び出して新しいフィールド定義を追加する。
 */

import { useActionState, useRef } from "react";
import { addFieldDefinition } from "@/lib/cms/actions";
import type { ActionResult } from "@/lib/cms/actions";
import type { FieldType } from "@/domain/cms";

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "テキスト",
  textarea: "テキストエリア",
  rich_text: "リッチテキスト",
  number: "数値（整数）",
  money: "金額（円）",
  boolean: "真偽値",
  select: "セレクト",
  multi_select: "複数選択",
  tag: "タグ",
  date: "日付",
  url: "URL",
  image: "画像",
  image_gallery: "画像ギャラリー",
};

interface Props {
  entity: string;
  fieldTypes: readonly FieldType[];
}

const initialState: ActionResult<{ id: string }> = { ok: false };

async function addFieldAction(
  _prev: ActionResult<{ id: string }>,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const raw = {
    entity: formData.get("entity") as string,
    key: formData.get("key") as string,
    label: formData.get("label") as string,
    type: formData.get("type") as FieldType,
    groupLabel: (formData.get("groupLabel") as string) || undefined,
    sortOrder: Number(formData.get("sortOrder") ?? "0"),
    isPublic: formData.getAll("isPublic").includes("true"),
    isRequired: formData.getAll("isRequired").includes("true"),
    helpText: (formData.get("helpText") as string) || undefined,
    options: (() => {
      const choicesRaw = formData.get("choices") as string;
      if (!choicesRaw) return undefined;
      const choices = choicesRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return choices.length > 0 ? { choices } : undefined;
    })(),
  };
  return addFieldDefinition(raw);
}

export function AddFieldForm({ entity, fieldTypes }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    addFieldAction,
    initialState,
  );

  // 成功時にフォームをリセット
  if (state.ok && formRef.current) {
    formRef.current.reset();
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      className="space-y-4 max-w-xl"
      aria-label="フィールド追加フォーム"
    >
      {/* entity は hidden で渡す */}
      <input type="hidden" name="entity" value={entity} />

      {/* エラー */}
      {!state.ok && state.error && (
        <div
          role="alert"
          className="p-3 text-sm border border-adm-danger text-adm-danger rounded"
          style={{ borderRadius: "4px" }}
        >
          {state.error}
        </div>
      )}

      {/* 成功 */}
      {state.ok && state.data && (
        <div
          role="status"
          className="p-3 text-sm border border-adm-primary text-adm-primary rounded"
          style={{ borderRadius: "4px" }}
        >
          フィールドを追加しました（ID: {state.data.id}）
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {/* key */}
        <div>
          <label
            htmlFor="field-key"
            className="block text-xs font-medium text-adm-text mb-1"
          >
            key <span className="text-adm-danger">*</span>
            <span className="ml-1 text-adm-text/50 font-normal">（変更不可）</span>
          </label>
          <input
            id="field-key"
            name="key"
            type="text"
            required
            pattern="[a-z][a-z0-9_]*"
            placeholder="good_at"
            className="w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary"
            style={{ borderRadius: "4px" }}
          />
          <p className="mt-1 text-xs text-adm-text/50">小文字英数字・アンダースコアのみ</p>
        </div>

        {/* label */}
        <div>
          <label
            htmlFor="field-label"
            className="block text-xs font-medium text-adm-text mb-1"
          >
            ラベル <span className="text-adm-danger">*</span>
          </label>
          <input
            id="field-label"
            name="label"
            type="text"
            required
            placeholder="得意な施術"
            className="w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary"
            style={{ borderRadius: "4px" }}
          />
        </div>

        {/* type */}
        <div>
          <label
            htmlFor="field-type"
            className="block text-xs font-medium text-adm-text mb-1"
          >
            型 <span className="text-adm-danger">*</span>
            <span className="ml-1 text-adm-text/50 font-normal">（変更不可）</span>
          </label>
          <select
            id="field-type"
            name="type"
            required
            defaultValue="text"
            className="w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text focus:outline-none focus:border-adm-primary"
            style={{ borderRadius: "4px" }}
          >
            {fieldTypes.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        {/* sortOrder */}
        <div>
          <label
            htmlFor="field-sort-order"
            className="block text-xs font-medium text-adm-text mb-1"
          >
            並び順
          </label>
          <input
            id="field-sort-order"
            name="sortOrder"
            type="number"
            defaultValue={0}
            step={10}
            className="w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text focus:outline-none focus:border-adm-primary"
            style={{ borderRadius: "4px" }}
          />
        </div>

        {/* groupLabel */}
        <div>
          <label
            htmlFor="field-group-label"
            className="block text-xs font-medium text-adm-text mb-1"
          >
            グループ名
          </label>
          <input
            id="field-group-label"
            name="groupLabel"
            type="text"
            placeholder="基本情報"
            className="w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary"
            style={{ borderRadius: "4px" }}
          />
        </div>

        {/* choices（select / multi_select 用） */}
        <div>
          <label
            htmlFor="field-choices"
            className="block text-xs font-medium text-adm-text mb-1"
          >
            選択肢
            <span className="ml-1 text-adm-text/50 font-normal">（select/multi_select のとき）</span>
          </label>
          <input
            id="field-choices"
            name="choices"
            type="text"
            placeholder="オイル,指圧,リンパ"
            className="w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary"
            style={{ borderRadius: "4px" }}
          />
          <p className="mt-1 text-xs text-adm-text/50">カンマ区切りで入力</p>
        </div>
      </div>

      {/* helpText */}
      <div>
        <label
          htmlFor="field-help-text"
          className="block text-xs font-medium text-adm-text mb-1"
        >
          説明文（ヘルプテキスト）
        </label>
        <input
          id="field-help-text"
          name="helpText"
          type="text"
          placeholder="入力例や補足説明"
          className="w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary"
          style={{ borderRadius: "4px" }}
        />
      </div>

      {/* トグル群 */}
      <div className="flex items-center gap-6">
        <label className="flex items-center gap-2 text-sm text-adm-text cursor-pointer">
          <input type="hidden" name="isPublic" value="false" />
          <input type="checkbox" name="isPublic" value="true" className="accent-adm-primary" />
          公開側に表示
        </label>
        <label className="flex items-center gap-2 text-sm text-adm-text cursor-pointer">
          <input type="hidden" name="isRequired" value="false" />
          <input type="checkbox" name="isRequired" value="true" className="accent-adm-primary" />
          必須
        </label>
      </div>

      {/* 送信ボタン */}
      <div>
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-medium bg-adm-primary text-white rounded disabled:opacity-50 hover:bg-adm-primary/90 transition-colors"
          style={{ borderRadius: "4px" }}
        >
          {isPending ? "追加中…" : "フィールドを追加"}
        </button>
      </div>
    </form>
  );
}
