/**
 * CMS ドメイン型（spec 3-1）。DB にも Next.js にも依存しない純粋な型定義。
 * 値は entity_records の draft/published JSONB カラムに入れる。
 */

/** CMS フィールド型（field_type enum と同一の並び / 0000_init.sql） */
export type FieldType =
  | "text"
  | "textarea"
  | "rich_text"
  | "number"
  | "boolean"
  | "select"
  | "multi_select"
  | "tag"
  | "image"
  | "image_gallery"
  | "date"
  | "url"
  | "money";

export const FIELD_TYPES: readonly FieldType[] = [
  "text",
  "textarea",
  "rich_text",
  "number",
  "boolean",
  "select",
  "multi_select",
  "tag",
  "image",
  "image_gallery",
  "date",
  "url",
  "money",
] as const;

/** select / multi_select のオプション（JSONB の options カラムに格納） */
export interface FieldOptions {
  /** select / multi_select / tag の選択肢 */
  choices?: string[];
  /** number / money の最小値 */
  min?: number;
  /** number / money の最大値 */
  max?: number;
}

/**
 * field_definitions の1行を表す型（DB 行から写像して使う）。
 * DB への書き込みは src/lib/cms/ の server 関数経由。
 */
export interface FieldDefinition {
  id: string;
  entity: string;
  /** 変更禁止（spec 3-1: key の変更は禁止。ラベルだけ変えられる） */
  key: string;
  label: string;
  type: FieldType;
  options: FieldOptions | null;
  groupLabel: string | null;
  sortOrder: number;
  isPublic: boolean;
  isRequired: boolean;
  isFilterable: boolean;
  helpText: string | null;
  /** 論理削除（null = 有効。非 null = 非表示扱い） */
  deletedAt: Date | null;
  createdAt: Date;
}

/**
 * フィールド追加時の入力型（key は追加時のみ指定可能。変更不可）。
 */
export interface AddFieldInput {
  entity: string;
  key: string;
  label: string;
  type: FieldType;
  options?: FieldOptions;
  groupLabel?: string;
  sortOrder?: number;
  isPublic?: boolean;
  isRequired?: boolean;
  isFilterable?: boolean;
  helpText?: string;
}

/**
 * フィールド更新時の入力型（key・type は変更不可 / spec 3-1）。
 */
export interface UpdateFieldInput {
  id: string;
  label?: string;
  options?: FieldOptions;
  groupLabel?: string;
  sortOrder?: number;
  isPublic?: boolean;
  isRequired?: boolean;
  isFilterable?: boolean;
  helpText?: string;
}

/**
 * entity_records の1行を表す型。
 */
export interface EntityRecord {
  id: string;
  entity: string;
  slug: string;
  draft: Record<string, unknown>;
  published: Record<string, unknown> | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
