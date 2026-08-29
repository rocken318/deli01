/**
 * buildZodSchema: field_definitions の配列から実行時に Zod スキーマを組み立てる（spec 3-1）。
 *
 * - DB にも Next.js にも依存しない純粋関数（ユニットテスト可能）
 * - field_type ごとに適切な Zod バリデーションを組み立てる
 * - isRequired=false のフィールドは .optional() でラップする
 * - 金額は整数（円）のみ。小数は拒否（spec 禁止事項）
 * - `any` 型禁止（spec 禁止事項）
 */

import { z } from "zod";
import type { FieldDefinition } from "./types";

/** buildZodSchema の戻り値型 */
export type DynamicSchema = z.ZodObject<Record<string, z.ZodTypeAny>>;

/**
 * 1 つのフィールド定義から Zod スキーマ（必須 / 任意を考慮しない素の型）を組む。
 * isRequired の処理は buildZodSchema で行う。
 */
function buildFieldSchema(def: FieldDefinition): z.ZodTypeAny {
  const { type, options } = def;

  switch (type) {
    case "text":
    case "textarea":
    case "rich_text":
      return z.string().trim();

    case "number":
      // 整数のみ（spec 禁止: 金額に小数を使わない。number も整数で運用）
      return z.number().int("整数を入力してください");

    case "money":
      // 金額は整数（円）、0以上（spec 禁止: 金額に小数を使わない）
      return z.number().int("金額は整数（円）で入力してください").min(0, "0円以上で入力してください");

    case "boolean":
      return z.boolean();

    case "select": {
      const choices = options?.choices;
      if (choices && choices.length > 0) {
        // z.enum は ["a", ...rest] のタプル形式を要求する
        const [first, ...rest] = choices;
        return z.enum([first as string, ...rest] as [string, ...string[]]);
      }
      return z.string();
    }

    case "multi_select":
    case "tag":
      return z.array(z.string());

    case "date":
      return z.string().regex(
        /^\d{4}-\d{2}-\d{2}$/,
        "YYYY-MM-DD 形式で入力してください",
      );

    case "url":
      return z.string().url("有効な URL を入力してください");

    case "image":
      // 後続フェーズで実装（spec: image/image_gallery は後続フェーズ）。緩めのバリデーション
      return z.string();

    case "image_gallery":
      // 後続フェーズで実装（spec: image/image_gallery は後続フェーズ）。緩めのバリデーション
      return z.array(z.string());

    default: {
      // 網羅チェック。未知の type は文字列にフォールバック
      const _exhaustive: never = type;
      void _exhaustive;
      return z.string();
    }
  }
}

/**
 * field_definitions の配列から実行時 Zod スキーマを組み立てる。
 *
 * - 論理削除済み（deletedAt !== null）の定義は除外する
 * - isRequired = false なら .optional() でラップする
 * - 結果は key をプロパティ名とする z.ZodObject
 *
 * @param defs - getFieldDefinitions() から取得した定義の配列（deletedAt null のみを渡すことを推奨）
 */
export function buildZodSchema(defs: FieldDefinition[]): DynamicSchema {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const def of defs) {
    // 論理削除済みは除外
    if (def.deletedAt !== null) continue;

    const base = buildFieldSchema(def);
    shape[def.key] = def.isRequired ? base : base.optional();
  }

  return z.object(shape);
}
