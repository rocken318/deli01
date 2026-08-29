import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
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

/**
 * 汎用 entity レコード（フェーズ2 / spec 3-1）。
 * フィールド定義テーブル + JSONB 方式の保存先。
 * draft が編集中、published が公開中（null なら未公開）。
 */
export const entityRecords = pgTable(
  "entity_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entity: text("entity").notNull(),
    slug: text("slug").notNull(),
    draft: jsonb("draft").notNull().default({}),
    published: jsonb("published"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    entitySlugUnique: unique("entity_records_entity_slug_unique").on(
      t.entity,
      t.slug,
    ),
  }),
);

/** アプリのロール（spec 体制 / 15章）。ドメイン側の Role 型と同一の並び */
export const appRole = pgEnum("app_role", [
  "owner",
  "admin",
  "reception",
  "therapist",
]);

/**
 * アプリ内ユーザー（フェーズ1 / 0001_auth.sql）。
 * Supabase auth.users とは auth_user_id で紐付け（live 配線までは null）。
 * therapist ロールのみ therapist_id を持てる（CHECK は SQL 側で定義）。
 */
export const appUsers = pgTable("app_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  authUserId: uuid("auth_user_id").unique(),
  role: appRole("role").notNull(),
  therapistId: uuid("therapist_id"),
  displayName: text("display_name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 監査ログ（追記専用 / フェーズ1）。update/delete は RLS＋grant で不可。
 * 住所閲覧（spec 13-3）は action='view' / entity='address'、CSV 出力は
 * action='export'、枠外予約（spec 7-2）は action='override' + after.reason。
 */
export const auditLogs = pgTable("audit_logs", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  actorUserId: uuid("actor_user_id").references(() => appUsers.id, {
    onDelete: "set null",
  }),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: uuid("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  ip: text("ip"),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** face_visibility enum（spec 3-7: セラピスト写真の顔出し可否） */
export const faceVisibility = pgEnum("face_visibility", ["face", "eyes", "none"]);

/**
 * メディアライブラリ（spec 3-7）。
 * alt は必須（未入力では公開不可）。
 */
export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  storagePath: text("storage_path").notNull().default(""),
  url: text("url").notNull().default(""),
  mime: text("mime").notNull().default("image/webp"),
  width: integer("width"),
  height: integer("height"),
  alt: text("alt").notNull(),
  tags: text("tags").array().notNull().default([]),
  consentFlag: boolean("consent_flag").notNull().default(false),
  consentDate: text("consent_date"),
  faceVisibility: faceVisibility("face_visibility").notNull().default("none"),
  isPlaceholder: boolean("is_placeholder").notNull().default(false),
  /** 退職処理（retireTherapist）で一括 true に設定（spec 3-7） */
  isHidden: boolean("is_hidden").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 固定ページ（spec 3-6）。
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    locale: text("locale").notNull().default("ja"),
    draftFields: jsonb("draft_fields").notNull().default({}),
    publishedFields: jsonb("published_fields"),
    draftBlocks: jsonb("draft_blocks").notNull().default([]),
    publishedBlocks: jsonb("published_blocks"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    seoOgpImageId: uuid("seo_ogp_image_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugLocaleUnique: unique("pages_slug_locale_unique").on(t.slug, t.locale),
  }),
);

/**
 * 禁止語リスト（spec 13-2）。
 */
export const bannedWords = pgTable("banned_words", {
  id: uuid("id").primaryKey().defaultRandom(),
  word: text("word").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** therapist_status enum（spec 3-8） */
export const therapistStatus = pgEnum("therapist_status", [
  "active",
  "inactive",
  "retired",
]);

/**
 * セラピストマスタ（spec 3-8 / 4章 / 0004_therapists.sql）。
 * 内部情報（status・display_order）と entity_records（プロフィール）は分離する。
 * app_users との紐付けは app_user_id で行う。
 */
export const therapists = pgTable("therapists", {
  id: uuid("id").primaryKey().defaultRandom(),
  appUserId: uuid("app_user_id").references(() => appUsers.id, { onDelete: "set null" }),
  slug: text("slug").notNull().unique(),
  status: therapistStatus("status").notNull().default("active"),
  displayOrder: integer("display_order").notNull().default(0),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// フェーズ6: エリア・移動時間・バッファ（spec 4章・5-1・5-2 / 0005_areas_travel.sql）
// ---------------------------------------------------------------------------

/**
 * PostGIS geography(Point,4326) の写像。
 * ORM からは WKT / EWKB hex のテキストとして受け渡す（距離計算は SQL 側 ST_Distance）。
 * DDL 上の定義は 0005_areas_travel.sql が正。
 */
const geographyPoint = customType<{ data: string }>({
  dataType() {
    return "geography(point, 4326)";
  },
});

/** エリア種別（spec 3-8 / 4章）。DDL は text + check 制約 */
export type AreaKind = "ward" | "city" | "station";

/** エリア（区・市・駅単位 / spec 4章）。center は代表点（徒歩距離・暫定値算出に使う） */
export const areas = pgTable("areas", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  kind: text("kind").$type<AreaKind>().notNull(),
  center: geographyPoint("center"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 車のエリア間移動時間マトリクス（spec 5-1 ★）。CMS で人手上書きが正 */
export const areaTravelTimes = pgTable(
  "area_travel_times",
  {
    fromAreaId: uuid("from_area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    toAreaId: uuid("to_area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    minutes: integer("minutes").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fromAreaId, t.toAreaId] }),
  }),
);

/** 徒歩の迂回係数・分速・上限距離（spec 5-1。単一行 / CMS で調整可） */
export const walkSettings = pgTable("walk_settings", {
  id: boolean("id").primaryKey().default(true),
  detourFactor: numeric("detour_factor", { precision: 4, scale: 2 }).notNull().default("1.30"),
  speedMPerMin: integer("speed_m_per_min").notNull().default(80),
  capMeters: integer("cap_meters").notNull().default(1600),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 区間ごとの徒歩時間上書き（橋・踏切などの分断 / spec 5-1） */
export const walkOverrides = pgTable(
  "walk_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromAreaId: uuid("from_area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    toAreaId: uuid("to_area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    addedMinutes: integer("added_minutes").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUnique: unique("walk_overrides_pair_unique").on(t.fromAreaId, t.toAreaId),
  }),
);

/** 車の時間帯係数（spec 5-1）。time_from > time_to は日跨ぎ区間（例 23:00〜05:00） */
export const travelTimeModifiers = pgTable("travel_time_modifiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  timeFrom: time("time_from").notNull(),
  timeTo: time("time_to").notNull(),
  multiplier: numeric("multiplier", { precision: 4, scale: 2 }).notNull().default("1.00"),
  additional: integer("additional").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 待機場所種別（spec 3-3: 自宅／最寄り駅／事務所）。DDL は text + check 制約 */
export type BaseKind = "home" | "station" | "office";

/** 待機場所（spec 4章）。shifts（フェーズ8）の待機開始/終了場所から参照される */
export const bases = pgTable("bases", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  kind: text("kind").$type<BaseKind>().notNull(),
  location: geographyPoint("location"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** バッファ設定のスコープ。DDL は text + check 制約 */
export type TravelBufferScope = "default" | "area";

/** 移動バッファ（spec 5-2）。既定1行 + エリア別上書き。駐車は車のみ加算（domain 側） */
export const travelBuffers = pgTable("travel_buffers", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").$type<TravelBufferScope>().notNull(),
  areaId: uuid("area_id").references(() => areas.id, { onDelete: "cascade" }),
  arriveMin: integer("arrive_min").notNull().default(10),
  parkingMin: integer("parking_min").notNull().default(15),
  beforeMin: integer("before_min").notNull().default(5),
  afterMin: integer("after_min").notNull().default(10),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
