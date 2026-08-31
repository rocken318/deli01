"use client";

/**
 * 動的フォーム（クライアントコンポーネント / spec 3-1）。
 *
 * field_definitions の配列から実行時にフォームを生成する。
 * 入力項目を1つ追加するだけで、コード変更なしにフォームに新項目が現れる。
 *
 * バリデーションは buildZodSchema() で定義から Zod スキーマを組み立てて行う。
 */

import { useActionState } from "react";
import { saveEntityRecord, publishEntityRecord } from "@/lib/cms/actions";
import type { ActionResult } from "@/lib/cms/actions";
import type { FieldDefinition } from "@/domain/cms";
import { buildZodSchema } from "@/domain/cms";
import { groupBy } from "./group-by";

interface Props {
  entity: string;
  slug: string;
  defs: FieldDefinition[];
  initialDraft: Record<string, unknown>;
  publishedAt: Date | null;
  /**
   * 汎用公開ボタン（PublishButton）を表示するか。既定は true。
   * therapist 詳細画面では掲載同意ゲート付きの専用公開のみ許可するため false を渡す（spec 3-7）。
   */
  showPublish?: boolean;
}

const initialState: ActionResult<{ id: string }> = { ok: false };

// ---------------------------------------------------------------------------
// フォーム送信アクション（Server Action のラッパ）
// ---------------------------------------------------------------------------

function makeSubmitAction(entity: string, slug: string, defs: FieldDefinition[]) {
  return async function submitAction(
    _prev: ActionResult<{ id: string }>,
    formData: FormData,
  ): Promise<ActionResult<{ id: string }>> {
    // フォームデータを収集
    const rawValues: Record<string, unknown> = {};
    for (const def of defs) {
      if (def.deletedAt !== null) continue;

      const raw = formData.get(def.key);
      switch (def.type) {
        case "boolean":
          // hidden("false") + checkbox("true") の2値が来る。get() は先頭="false" を
          // 返すため、getAll に "true" が含まれるかで判定する。
          rawValues[def.key] = formData.getAll(def.key).includes("true");
          break;
        case "number":
        case "money":
          rawValues[def.key] = raw ? Number(raw) : undefined;
          break;
        case "multi_select":
        case "tag":
        case "image_gallery": {
          const all = formData.getAll(def.key);
          rawValues[def.key] = all.filter((v) => v !== "");
          break;
        }
        default:
          rawValues[def.key] = raw || undefined;
      }
    }

    // buildZodSchema でバリデーション
    const schema = buildZodSchema(defs);
    const parsed = schema.safeParse(rawValues);
    if (!parsed.success) {
      const msg = parsed.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      return { ok: false, error: msg };
    }

    return saveEntityRecord(entity, slug, parsed.data as Record<string, unknown>);
  };
}

// ---------------------------------------------------------------------------
// フィールドコンポーネント（型ごと）
// ---------------------------------------------------------------------------

function FieldInput({
  def,
  defaultValue,
}: {
  def: FieldDefinition;
  defaultValue: unknown;
}) {
  const id = `field-${def.key}`;
  const baseClass =
    "w-full px-3 py-2 text-sm border border-adm-border rounded bg-adm-surface text-adm-text placeholder:text-adm-text/40 focus:outline-none focus:border-adm-primary";
  const baseStyle = { borderRadius: "4px" };

  switch (def.type) {
    case "text":
    case "url":
      return (
        <input
          id={id}
          name={def.key}
          type={def.type === "url" ? "url" : "text"}
          defaultValue={typeof defaultValue === "string" ? defaultValue : ""}
          required={def.isRequired}
          className={baseClass}
          style={baseStyle}
          placeholder={def.helpText ?? ""}
        />
      );

    case "textarea":
    case "rich_text":
      return (
        <textarea
          id={id}
          name={def.key}
          defaultValue={typeof defaultValue === "string" ? defaultValue : ""}
          required={def.isRequired}
          rows={4}
          className={baseClass}
          style={baseStyle}
          placeholder={def.helpText ?? ""}
        />
      );

    case "number":
    case "money":
      return (
        <input
          id={id}
          name={def.key}
          type="number"
          defaultValue={typeof defaultValue === "number" ? defaultValue : ""}
          required={def.isRequired}
          step={1}
          min={def.type === "money" ? 0 : undefined}
          className={baseClass}
          style={baseStyle}
          placeholder={def.type === "money" ? "例: 6000" : ""}
        />
      );

    case "boolean":
      return (
        <div className="flex items-center gap-2 mt-1">
          <input type="hidden" name={def.key} value="false" />
          <input
            id={id}
            name={def.key}
            type="checkbox"
            value="true"
            defaultChecked={defaultValue === true}
            className="w-4 h-4 border-adm-border accent-adm-primary"
            style={{ borderRadius: "4px" }}
          />
          <label htmlFor={id} className="text-sm text-adm-text cursor-pointer">
            {def.label}
          </label>
        </div>
      );

    case "select": {
      const choices = def.options?.choices ?? [];
      return (
        <select
          id={id}
          name={def.key}
          defaultValue={typeof defaultValue === "string" ? defaultValue : ""}
          required={def.isRequired}
          className={baseClass}
          style={baseStyle}
        >
          {!def.isRequired && <option value="">（選択してください）</option>}
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
    }

    case "multi_select":
    case "tag": {
      const choices = def.options?.choices ?? [];
      const selected = Array.isArray(defaultValue) ? defaultValue : [];
      return (
        <div className="space-y-1">
          {choices.map((c) => (
            <label
              key={c}
              className="flex items-center gap-2 text-sm text-adm-text cursor-pointer"
            >
              <input
                type="checkbox"
                name={def.key}
                value={c}
                defaultChecked={selected.includes(c)}
                className="w-4 h-4 border-adm-border accent-adm-primary"
                style={{ borderRadius: "4px" }}
              />
              {c}
            </label>
          ))}
          {choices.length === 0 && (
            <p className="text-xs text-adm-text/50">
              選択肢がありません。入力項目で choices を設定してください。
            </p>
          )}
        </div>
      );
    }

    case "date":
      return (
        <input
          id={id}
          name={def.key}
          type="date"
          defaultValue={typeof defaultValue === "string" ? defaultValue : ""}
          required={def.isRequired}
          className={baseClass}
          style={baseStyle}
        />
      );

    case "image":
    case "image_gallery":
      return (
        <div className="p-3 border border-dashed border-adm-border rounded text-xs text-adm-text/50 text-center" style={{ borderRadius: "4px" }}>
          画像アップロード機能は後続フェーズ（フェーズ3）で実装予定です
        </div>
      );

    default:
      return (
        <input
          id={id}
          name={def.key}
          type="text"
          defaultValue={typeof defaultValue === "string" ? defaultValue : ""}
          className={baseClass}
          style={baseStyle}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

export function DynamicForm({
  entity,
  slug,
  defs,
  initialDraft,
  publishedAt,
  showPublish = true,
}: Props) {
  const submitAction = makeSubmitAction(entity, slug, defs);
  const [state, formAction, isPending] = useActionState(submitAction, initialState);

  // 表示対象のフィールド（論理削除済みを除く）
  const activeDefs = defs.filter((d) => d.deletedAt === null);

  // グループ別に分類。並びは spec 3-1「sort_order に従って並べる」に合わせ、
  // 各グループ内の最小 sort_order 順にする（辞書順にしない）。
  const grouped = groupBy(activeDefs, (d) => d.groupLabel ?? "");
  const groupMinSort = new Map<string, number>();
  for (const [key, fields] of grouped) {
    groupMinSort.set(key, Math.min(...fields.map((f) => f.sortOrder)));
  }
  const groupKeys = Array.from(grouped.keys()).sort((a, b) => {
    if (a === "") return 1; // グループなしは末尾
    if (b === "") return -1;
    return (groupMinSort.get(a) ?? 0) - (groupMinSort.get(b) ?? 0);
  });

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-6" aria-label="コンテンツ編集フォーム">
      {/* エラー / 成功メッセージ */}
      {state.error && (
        <div
          role="alert"
          className="p-3 text-sm border border-adm-danger text-adm-danger rounded"
          style={{ borderRadius: "4px" }}
        >
          {state.error}
        </div>
      )}
      {state.ok && state.data && (
        <div
          role="status"
          className="p-3 text-sm border border-adm-primary text-adm-primary rounded"
          style={{ borderRadius: "4px" }}
        >
          下書きを保存しました
        </div>
      )}

      {activeDefs.length === 0 ? (
        <p className="text-sm text-adm-text/60 py-4">
          表示できるフィールドがありません。入力項目を確認してください。
        </p>
      ) : (
        /* フィールドをグループ別に描画 */
        groupKeys.map((groupKey) => {
          const fields = grouped.get(groupKey) ?? [];
          return (
            <fieldset key={groupKey || "__no_group"} className="space-y-4">
              {groupKey && (
                <legend className="text-xs font-semibold text-adm-text/60 uppercase tracking-wider pb-2 border-b border-adm-border w-full">
                  {groupKey}
                </legend>
              )}
              {fields.map((def) => (
                <div key={def.key}>
                  {/* boolean はラベルをフィールド内で表示 */}
                  {def.type !== "boolean" && (
                    <label
                      htmlFor={`field-${def.key}`}
                      className="block text-sm font-medium text-adm-text mb-1"
                    >
                      {def.label}
                      {def.isRequired && (
                        <span className="ml-1 text-adm-danger text-xs">*</span>
                      )}
                    </label>
                  )}
                  {def.helpText && def.type !== "boolean" && (
                    <p className="text-xs text-adm-text/50 mb-1">{def.helpText}</p>
                  )}
                  <FieldInput
                    def={def}
                    defaultValue={initialDraft[def.key]}
                  />
                </div>
              ))}
            </fieldset>
          );
        })
      )}

      {/* 公開状態 */}
      {publishedAt && (
        <p className="text-xs text-adm-text/50">
          最終公開: {publishedAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
        </p>
      )}

      {/* 保存ボタン（この form 内） */}
      <div className="flex items-center gap-3 pt-4 border-t border-adm-border">
        <button
          type="submit"
          disabled={isPending}
          className="px-5 py-2 text-sm font-medium bg-adm-primary text-white rounded hover:bg-adm-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          style={{ borderRadius: "4px" }}
        >
          {isPending ? "保存中…" : "下書きを保存"}
        </button>
      </div>
      </form>
      {/* 公開は別 Server Action・別 form。form のネストは不正なので兄弟要素に置く。 */}
      {showPublish !== false && <PublishButton entity={entity} slug={slug} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 公開ボタン（独立した Server Action）
// ---------------------------------------------------------------------------

function PublishButton({ entity, slug }: { entity: string; slug: string }) {
  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult): Promise<ActionResult> => {
      return publishEntityRecord(entity, slug);
    },
    { ok: false } as ActionResult,
  );

  return (
    <form action={formAction}>
      {state.error && (
        <p className="text-xs text-adm-danger">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="px-5 py-2 text-sm font-medium border border-adm-primary text-adm-primary rounded hover:bg-adm-primary/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        style={{ borderRadius: "4px" }}
      >
        {isPending ? "公開中…" : "公開する"}
      </button>
    </form>
  );
}
