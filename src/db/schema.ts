import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle スキーマ（型つきクエリ用）。
 * PostGIS の geography / exclusion 制約 / RLS は手書き SQL マイグレーション
 * （migrations/*.sql）側で定義する。ここは ORM から触る形の写像。
 *
 * フェーズ0では CMS の背骨となる最小テーブルのみ。以降のフェーズで architect が拡張する。
 */

/** CMS フィールド型（spec 3-1） */
export const fieldType = pgEnum("field_type", [
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
]);

/** グローバル設定（屋号・ロゴ・電話・SNS・ナビ / spec 3-6） key-value */
export const siteSettings = pgTable("site_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 用語辞書（spec 13-1）。公開側テンプレートは必ずここを参照し、
 * 「マッサージ」等をハードコードしない。locale で多言語の下準備（spec 3-6・付録A-7）。
 */
export const terminology = pgTable(
  "terminology",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(), // service_noun / staff_noun / session_noun ...
    value: text("value").notNull(),
    locale: text("locale").notNull().default("ja"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    keyLocaleUnique: unique("terminology_key_locale_unique").on(
      t.key,
      t.locale,
    ),
  }),
);

/**
 * CMS 項目定義（spec 3-1）。方式はフィールド定義テーブル + JSONB。EAV にしない。
 * 値は対象テーブルの jsonb カラムに入れる（例: therapist_profiles.draft/published）。
 */
export const fieldDefinitions = pgTable(
  "field_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entity: text("entity").notNull(), // 'therapist' | 'course' | 'area' | 'page'
    key: text("key").notNull(), // 'good_at', 'years_of_experience' ...（変更禁止）
    label: text("label").notNull(),
    type: fieldType("type").notNull(),
    options: jsonb("options"),
    groupLabel: text("group_label"),
    sortOrder: integer("sort_order").notNull().default(0),
    isPublic: boolean("is_public").notNull().default(false),
    isRequired: boolean("is_required").notNull().default(false),
    isFilterable: boolean("is_filterable").notNull().default(false),
    helpText: text("help_text"),
    // 論理削除（spec 3-1: 項目の削除は論理削除。既存の値を巻き添えにしない）
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    entityKeyUnique: unique("field_definitions_entity_key_unique").on(
      t.entity,
      t.key,
    ),
  }),
);
