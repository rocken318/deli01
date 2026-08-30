import {
  bigint,
  boolean,
  customType,
  date,
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
  /** 車を使えるか（免許・車両 / spec 5-1）。false なら徒歩圏の予約のみ */
  canUseCar: boolean("can_use_car").notNull().default(true),
  /** 徒歩上限の個人差（m）。null = walk_settings.cap_meters の既定（spec 5-1） */
  walkCapMeters: integer("walk_cap_meters"),
  /** ランク（報酬レートの既定値に使う / spec L415・18-4。0016 で追加） */
  rankId: uuid("rank_id"),
  /** 適格請求書発行事業者の登録番号。null = 未登録（spec L935。0016 で追加） */
  invoiceRegNo: text("invoice_reg_no"),
  /** 源泉徴収フラグ。既定オフ（spec L936。額の自動判定はしない / 16章） */
  withholding: boolean("withholding").notNull().default(false),
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

// ---------------------------------------------------------------------------
// フェーズ7: コース・オプション・ホテルマスタ（spec 3-4・8-2・18章 /
// 0006_courses_options_hotels.sql）
// ---------------------------------------------------------------------------

/**
 * コース（spec 4章・18-1）。金額はすべて整数（円）。小数禁止。
 * nomination_fee_default は通常指名料の既定値（個人別特例は後続フェーズ）。
 */
export const courses = pgTable("courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  durationMin: integer("duration_min").notNull(),
  price: integer("price").notNull(),
  nominationFeeDefault: integer("nomination_fee_default").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** オプションのバック種別（spec 3-4: 'fixed'=固定額（円） / 'rate'=率（%）） */
export const optionBackType = pgEnum("option_back_type", ["fixed", "rate"]);

/**
 * オプション（spec 3-4・18-2）。コースとは別の実体。
 * duration_min が空き枠計算の施術時間 L に効く（L = コース + オプション合計 / spec 5-3）。
 * 予約時には価格・時間・バックを reservation_options（フェーズ11）へスナップショットする。
 */
export const options = pgTable("options", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  price: integer("price").notNull(),
  durationMin: integer("duration_min").notNull().default(0),
  backType: optionBackType("back_type").notNull().default("rate"),
  backValue: integer("back_value").notNull().default(0),
  isPublic: boolean("is_public").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** オプションの対応セラピスト（spec 3-4）。**行が無ければ全員対応** */
export const optionAvailability = pgTable(
  "option_availability",
  {
    optionId: uuid("option_id")
      .notNull()
      .references(() => options.id, { onDelete: "cascade" }),
    therapistId: uuid("therapist_id")
      .notNull()
      .references(() => therapists.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.optionId, t.therapistId] }),
  }),
);

/**
 * ホテルマスタ（spec 8-2 ★）。
 * extra_minutes = 到着から部屋までの追加時間（分）。到着バッファに加算する
 * （domain の arrivalBuffers / フェーズ7 完了条件）。
 * is_blocked のホテルは予約を作らせない（isHotelBookable）。
 * area_id / location は仮登録（電話を止めない運用）のため null 可。
 */
// ---------------------------------------------------------------------------
// フェーズ8: 出勤予定（spec 3-3・4章 / 0007_shifts.sql）
// ---------------------------------------------------------------------------

/**
 * 出勤予定（spec 3-3・4章）。実績（attendances / spec 3-5）とは分ける。
 * 1セラピスト×1日に1行（unique）。is_day_off は当日欠勤ワンタップ（行は消さない）。
 * base_start/end は待機開始/終了場所。フェーズ9の gap0 / gap_n（帰れること）に使う。
 */
export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    therapistId: uuid("therapist_id")
      .notNull()
      .references(() => therapists.id, { onDelete: "cascade" }),
    workDate: date("work_date").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    baseStartId: uuid("base_start_id").references(() => bases.id, { onDelete: "set null" }),
    baseEndId: uuid("base_end_id").references(() => bases.id, { onDelete: "set null" }),
    /** 1日の最大施術本数（spec 3-3 / 5-3 手順3）。null = 上限なし */
    maxBookings: integer("max_bookings"),
    note: text("note"),
    isDayOff: boolean("is_day_off").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    therapistDayUnique: unique("shifts_therapist_day_unique").on(t.therapistId, t.workDate),
  }),
);

/** その日に対応できるエリア（spec 3-3「全域とは限らない」）。出勤表とフェーズ9が参照 */
export const shiftAreas = pgTable(
  "shift_areas",
  {
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id, { onDelete: "cascade" }),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shiftId, t.areaId] }),
  }),
);

// ---------------------------------------------------------------------------
// フェーズ13: 送信テンプレート・送信ログ（spec 8-3 ★ / 0011_message_templates.sql）
// ---------------------------------------------------------------------------

/** テンプレート種別（spec 8-3: 'inquiry'=打診用 / 'confirmed'=確定用） */
export const templateKind = pgEnum("template_kind", ["inquiry", "confirmed"]);

/**
 * セラピストへの送信テンプレート（spec 8-3）。CMS 編集可・kind ごとに1行。
 * 差し込み変数は {{日時}} 形式（src/domain/dispatch）。編集は owner/admin のみ、
 * reception は select のみ（RLS は SQL 側が正）。
 */
export const messageTemplates = pgTable("message_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: templateKind("kind").notNull().unique(),
  name: text("name").notNull(),
  body: text("body").notNull(),
  locale: text("locale").notNull().default("ja"),
  isActive: boolean("is_active").notNull().default(true),
  updatedBy: uuid("updated_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 送信ログ（spec 8-3「誰の情報を、いつ、誰に渡したか」。監査対象・追記専用）。
 * update/delete は grant もポリシーも無し（0011）。id は audit_logs と同様
 * bigint identity で追記順を保つ。body_snapshot に実際にコピーした本文を控える。
 */
export const dispatchLogs = pgTable("dispatch_logs", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  reservationId: uuid("reservation_id").notNull(),
  therapistId: uuid("therapist_id")
    .notNull()
    .references(() => therapists.id, { onDelete: "restrict" }),
  kind: templateKind("kind").notNull(),
  bodySnapshot: text("body_snapshot").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => appUsers.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const hotels = pgTable("hotels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  nameKana: text("name_kana"),
  address: text("address"),
  location: geographyPoint("location"),
  areaId: uuid("area_id").references(() => areas.id, { onDelete: "set null" }),
  entryNote: text("entry_note"),
  parkingNote: text("parking_note"),
  extraMinutes: integer("extra_minutes").notNull().default(0),
  isBlocked: boolean("is_blocked").notNull().default(false),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// フェーズ16: ポイント台帳・引き継ぎメモ・指名NG・コース×セラピスト
// （0014_points_handover_nomination.sql の写像。customers / reservations は
//   手書き SQL 側のみのため、それらへの FK は素の uuid 列で表す）
// ---------------------------------------------------------------------------

/** ポイント台帳の仕訳種別（spec 9章 L828） */
export const pointEntryType = pgEnum("point_entry_type", [
  "earn",
  "use",
  "expire",
  "adjust",
  "reverse",
]);

/**
 * ポイント追記専用台帳 ★（spec 9章 L826-833）。残高 = sum(points)。
 * update/delete は grant なし（0014）。ロット = points>0 かつ lotId null の行。
 * use/expire は負で必ず lotId（どの付与を消費/失効したか）を持つ。
 * 期限（expiresAt）は付与ロット単位（spec L837 先入先出）。
 */
export const pointEntries = pgTable("point_entries", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  customerId: uuid("customer_id").notNull(),
  type: pointEntryType("type").notNull(),
  /** earn:+ / use・expire:−。0 不可・整数のみ（円換算 1P=1円） */
  points: integer("points").notNull(),
  reservationId: uuid("reservation_id"),
  reason: text("reason"),
  /** 付与ロットの失効期限（ロット行のみ） */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** 消費/失効/逆仕訳の対象ロット（point_entries.id） */
  lotId: bigint("lot_id", { mode: "bigint" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

/**
 * 施術後の引き継ぎメモ（spec 9章 L810-814）。
 * therapist には「その顧客の次回以降の自分の担当予約があるとき」だけ RLS で開示。
 * 顧客本人・無関係のセラピストには見せない（受入 L1123）。
 */
export const handoverNotes = pgTable("handover_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull(),
  reservationId: uuid("reservation_id"),
  /** 書いた人 */
  therapistId: uuid("therapist_id")
    .notNull()
    .references(() => therapists.id, { onDelete: "restrict" }),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 指名NG（spec 9章 L808）。この組合せは公開側でも予約不可
 * （reservations への guard トリガが DB 層で拒否 / 0014）。
 */
export const customerTherapistNg = pgTable(
  "customer_therapist_ng",
  {
    customerId: uuid("customer_id").notNull(),
    therapistId: uuid("therapist_id")
      .notNull()
      .references(() => therapists.id, { onDelete: "cascade" }),
    reason: text("reason"),
    createdBy: uuid("created_by").references(() => appUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.customerId, t.therapistId] }),
  }),
);

/**
 * コース×セラピストの対応可否と個別指名料（spec 9章 L817）。
 * nominationFee null = courses.nominationFeeDefault を使う。
 */
export const therapistCourses = pgTable(
  "therapist_courses",
  {
    therapistId: uuid("therapist_id")
      .notNull()
      .references(() => therapists.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    isAvailable: boolean("is_available").notNull().default(true),
    /** 個別指名料（円・整数）。null = コース既定 */
    nominationFee: integer("nomination_fee"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.therapistId, t.courseId] }),
  }),
);

// ---------------------------------------------------------------------------
// フェーズ17: 売上台帳・支払内訳・回数券・経費
// （0015_revenue_tickets_expenses.sql の写像。追記専用・部分 unique・RLS は
//   手書き SQL 側で定義。reservations / customers への FK は素の uuid 列）
// ---------------------------------------------------------------------------

/** 売上行の種別（spec 10章 L856。値引行 discount/point_use は負で記帳） */
export const revenueLineType = pgEnum("revenue_line_type", [
  "course",
  "option",
  "nomination",
  "transport",
  "midnight",
  "discount",
  "point_use",
  "ticket_redeem",
]);

/** 支払方法（spec L855。1予約で併用可） */
export const paymentMethod = pgEnum("payment_method", [
  "cash",
  "card",
  "emoney",
  "ticket",
  "point",
]);

/** 回数券台帳の仕訳種別（spec L857） */
export const ticketEntryType = pgEnum("ticket_entry_type", [
  "purchase",
  "redeem",
  "expire",
  "reverse",
  "adjust",
]);

/** 経費カテゴリ（spec L868） */
export const expenseCategory = pgEnum("expense_category", [
  "oil",
  "supplies",
  "parking",
  "ads",
  "other",
]);

/**
 * 売上追記専用台帳 ★（spec L856・L858「集計は revenue_lines だけを読む」）。
 * 独立行で計上（合算しない）。update/delete は grant なし。修正は reversalOf
 * つき逆仕訳行の追記。二重計上は部分 unique（core/singleton/option）が DB 層で防止。
 */
export const revenueLines = pgTable("revenue_lines", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  reservationId: uuid("reservation_id"),
  lineType: revenueLineType("line_type").notNull(),
  /** 円・整数。売上行は正、discount/point_use は負。0 行は立てない */
  amount: integer("amount").notNull(),
  /** 集計軸（期間 × エリア × セラピスト / spec L860）。計上時に予約から写す */
  areaId: uuid("area_id").references(() => areas.id, { onDelete: "set null" }),
  therapistId: uuid("therapist_id").references(() => therapists.id, {
    onDelete: "set null",
  }),
  /** option 行のみ（(予約, option) 単位の二重計上防止キー） */
  optionId: uuid("option_id").references(() => options.id, {
    onDelete: "restrict",
  }),
  /** 計上日基準の日時。予約由来の行は start_at（施術日基準） */
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  /** 逆仕訳: 元行（revenue_lines.id）。逆仕訳行は符号規約の対象外 */
  reversalOf: bigint("reversal_of", { mode: "bigint" }),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

/** 支払方法の内訳（spec L855）。1予約に複数行可（現金＋回数券など）。追記専用 */
export const payments = pgTable("payments", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  reservationId: uuid("reservation_id").notNull(),
  method: paymentMethod("method").notNull(),
  /** 円・整数。修正は負額の追記 */
  amount: integer("amount").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

/**
 * 回数券追記専用台帳 ★（spec L857）。残回数 = sum(count) / 前受金残高 = sum(amount)。
 * ロット = purchase 行（count>0・lotId null）。redeem/expire は負で lotId 必須。
 * 端数配分（受入 L1092）は amount で表す（10,000円3回券 → −3,333/−3,333/−3,334）。
 */
export const ticketEntries = pgTable("ticket_entries", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  customerId: uuid("customer_id").notNull(),
  type: ticketEntryType("type").notNull(),
  /** 回数の増減。purchase:+N / redeem:−1 / expire:−残回数 */
  count: integer("count").notNull(),
  /** 前受金の増減（円・整数）。purchase:+券面総額 / redeem:−配分額 */
  amount: integer("amount").notNull(),
  /** 名目単価（表示用・任意）。正は amount（端数配分のため単価は一意でない） */
  unitPrice: integer("unit_price"),
  reservationId: uuid("reservation_id"),
  reason: text("reason"),
  /** 失効期限（purchase ロット単位） */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** 消化/失効/逆仕訳の対象ロット（ticket_entries.id） */
  lotId: bigint("lot_id", { mode: "bigint" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

/** 経費（spec L868。突合 11-6 の「経費」の出所）。入力データなので編集可 */
export const expenses = pgTable("expenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  category: expenseCategory("category").notNull(),
  /** 円・整数・正 */
  amount: integer("amount").notNull(),
  spentOn: date("spent_on").notNull(),
  areaId: uuid("area_id").references(() => areas.id, { onDelete: "set null" }),
  note: text("note"),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// フェーズ18: 報酬（業務委託バック）・締め・支払（spec 11章 / 0016_payouts.sql）
// ---------------------------------------------------------------------------

/** 報酬レートの対象種別（spec 11-1 L884-885） */
export const payoutTargetType = pgEnum("payout_target_type", [
  "course",
  "option",
  "nomination",
  "transport",
  "late_night",
  "cancel_fee",
]);

/** payout_lines の区分（target 種別 + 手動調整 / spec L905-906） */
export const payoutCategory = pgEnum("payout_category", [
  "course",
  "option",
  "nomination",
  "transport",
  "late_night",
  "cancel_fee",
  "adjustment",
]);

/** fixed = 円（整数） / rate = 率（整数%）（spec L887。numeric は使わない） */
export const payoutCalcType = pgEnum("payout_calc_type", ["fixed", "rate"]);

export const payoutStatus = pgEnum("payout_status", ["open", "closed", "paid"]);

/** 控除の種類（立替・備品・貸付 / spec L930。withholding = 源泉の手入力 / L936） */
export const payoutDeductionKind = pgEnum("payout_deduction_kind", [
  "advance",
  "supplies",
  "loan",
  "withholding",
  "other",
]);

/** セラピストのランク（報酬レートの既定値に使う / spec L415・18-4） */
export const therapistRanks = pgTable("therapist_ranks", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 報酬レート（spec 11-1）。優先順位 = 個別（therapistId）> ランク別（rankId）>
 * 既定（両方 null）。適用期間 [effectiveFrom, effectiveTo)。
 * value は calcType='fixed' なら円、'rate' なら整数%（0〜100）。
 * レート改定は「打ち切り + 新規行」。過去の確定報酬は変わらない（受入 L1094）。
 */
export const payoutRates = pgTable("payout_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  therapistId: uuid("therapist_id").references(() => therapists.id, {
    onDelete: "cascade",
  }),
  rankId: uuid("rank_id").references(() => therapistRanks.id, {
    onDelete: "cascade",
  }),
  targetType: payoutTargetType("target_type").notNull(),
  /** コースID・オプションID など。null = その種別の全対象 */
  targetId: uuid("target_id"),
  calcType: payoutCalcType("calc_type").notNull(),
  /** fixed: 円（整数） / rate: 整数%（0〜100） */
  value: integer("value").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

/**
 * 締め済みの支払（spec 11-4）。status='closed' でロック（DB トリガ）。
 * closed 後に許すのは closed→paid のみ。修正は payout_lines の逆仕訳のみ。
 * 期間の重複はセラピスト単位の exclusion 制約（0016）で拒否。
 */
export const payouts = pgTable("payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  therapistId: uuid("therapist_id").notNull(),
  /** 期間は日付の閉区間 [periodStart, periodEnd] */
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  /** 円・整数。gross = Σ payout_lines（期間内・逆仕訳込み） */
  gross: integer("gross").notNull().default(0),
  deductions: integer("deductions").notNull().default(0),
  /** net = gross − deductions（DB check で担保） */
  net: integer("net").notNull().default(0),
  status: payoutStatus("status").notNull().default("open"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  /** 締め時点のスナップショット（インボイス区分 / 源泉フラグ。spec L935-936） */
  invoiceRegNo: text("invoice_reg_no"),
  withholding: boolean("withholding").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

/**
 * 報酬の追記専用台帳 ★（spec 11-2）。修正は reversalOf の逆仕訳のみ。
 * calcNote に使ったレート・元金額・計算式のスナップショットを必ず残す
 * （spec L913・受入 L1098）。therapist は自分の行のみ select（RLS / 受入 L1134）。
 * 締め済み期間への insert は DB トリガが拒否（受入 L1094・L1097）。
 */
export const payoutLines = pgTable("payout_lines", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  therapistId: uuid("therapist_id").notNull(),
  /** 営業日（Asia/Tokyo の start_at の日付。逆仕訳・調整は計上日） */
  businessDate: date("business_date").notNull(),
  reservationId: uuid("reservation_id"),
  category: payoutCategory("category").notNull(),
  /** option 行のみ（(予約, option) 単位の二重計上防止キー） */
  optionId: uuid("option_id").references(() => options.id, {
    onDelete: "restrict",
  }),
  /** 円・整数。報酬行は正。adjustment と逆仕訳のみ負を許す */
  amount: integer("amount").notNull(),
  /** ★計算根拠（PayoutCalcNote / src/domain/payout）。jsonb not null */
  calcNote: jsonb("calc_note").notNull(),
  /** 逆仕訳: 元行（payout_lines.id） */
  reversalOf: bigint("reversal_of", { mode: "bigint" }),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

/** 控除（立替・備品・貸付・源泉手入力 / spec L930）。親 payout が open の間のみ可変 */
export const payoutDeductions = pgTable("payout_deductions", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  payoutId: uuid("payout_id").notNull(),
  kind: payoutDeductionKind("kind").notNull(),
  /** 円・整数・正 */
  amount: integer("amount").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

// ---------------------------------------------------------------------------
// フェーズ20: 通知アウトボックス・直前割
// （0017_notifications_flash_deals.sql の写像。unique(dedupe_key)・RLS・
//   追記専用 grant・reservations への FK は手書き SQL 側で定義）
// ---------------------------------------------------------------------------

/** v1 は email 中心。line は将来（spec 16章: LINE 自動送信は v1 でやらない） */
export const notificationChannel = pgEnum("notification_channel", [
  "email",
  "line",
]);

export const notificationKind = pgEnum("notification_kind", [
  "reminder_prev_day",
  "reminder_2h",
  "waitlist_open",
  "weekly_report",
  "flash_deal",
]);

export const notificationStatus = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
  "skipped",
]);

/**
 * 送信アウトボックス（フェーズ20）。実配信はスタブ（src/lib/notify/sender.ts に
 * 切り出し。②メール配線で差し替え）。dedupeKey の unique（手書き SQL 0017）が
 * 重複送信の最終防衛線（受入 L1131）。delete は grant しない（記録を消させない）。
 */
export const notifications = pgTable("notifications", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  channel: notificationChannel("channel").notNull().default("email"),
  kind: notificationKind("kind").notNull(),
  /** 宛先識別（メールアドレス / 電話番号。v1 の顧客はメールを持たないため電話番号） */
  recipient: text("recipient").notNull(),
  reservationId: uuid("reservation_id"),
  customerId: uuid("customer_id"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  status: notificationStatus("status").notNull().default("pending"),
  /** 送るべき時刻（リマインドなら start_at−24h / −2h） */
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** ★重複送信防止キー '{kind}:{参照ID}'（unique / 受入 L1131） */
  dedupeKey: text("dedupe_key").notNull().unique(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

/**
 * 通知テンプレ（kind ごとに1行・CMS 編集・{{変数}} / message_templates と同型）。
 * 補間は domain/notify の buildNotification（未定義変数は空文字・落ちない）。
 */
export const notificationTemplates = pgTable("notification_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: notificationKind("kind").notNull().unique(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  locale: text("locale").notNull().default("ja"),
  isActive: boolean("is_active").notNull().default(true),
  updatedBy: uuid("updated_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 直前割の適用履歴（spec L432・L650-654 / 追記専用）。
 * 金銭計上は revenue_lines の discount 負行（revenueLineId が1:1で指す）。
 * unique(reservationId) = 二重適用防止。appliedOn（JST 営業日）が
 * 1日の適用上限（受入 L1120）の日次カウント根拠。
 * 設定は site_settings.flash_deal_config（既定 enabled=false・雛形）。
 */
export const flashDeals = pgTable("flash_deals", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  reservationId: uuid("reservation_id").notNull().unique(),
  /** 適用時の割引率スナップショット（整数% 1..100） */
  ratePercent: integer("rate_percent").notNull(),
  /** 割引額（円・整数・正で保持。revenue_lines 側は負行） */
  amount: integer("amount").notNull(),
  /** 適用日（Asia/Tokyo の営業日） */
  appliedOn: date("applied_on").notNull(),
  /** 対応する revenue_lines.id（discount 行） */
  revenueLineId: bigint("revenue_line_id", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => appUsers.id, {
    onDelete: "set null",
  }),
});

// ---------------------------------------------------------------------------
// フェーズ21: CMS内AIアシスタント（spec 19章 / 0018_ai_actions.sql）
// ---------------------------------------------------------------------------

/** AI 操作の種別（spec 19-1 L1248-L1251） */
export const aiActionType = pgEnum("ai_action_type", [
  "generate",           // 下書き生成（プロフィール/キャッチ/お知らせ/FAQ/SEO）
  "rewrite",            // リライト・トーン調整
  "banned_word_suggest", // 禁止語検出＋言い換え提案
  "terminology_suggest", // 用語辞書の表記ゆれ統一案
  "structure_change",   // 構造変更提案（差分プレビュー→承認必須 / 受入 L1125）
]);

/** AI 操作の審査状態 */
export const aiActionStatus = pgEnum("ai_action_status", [
  "proposed", // AI 出力あり・未審査（初期状態）
  "approved", // owner/admin が承認 → draft にのみ反映済み
  "rejected", // owner/admin が却下（何も適用しない）
  "failed",   // AI 呼び出し失敗（ANTHROPIC_API_KEY 未設定を含む）
]);

/**
 * AI 操作履歴（追記専用 / フェーズ21 / spec L433・受入 L1126）。
 * - request/output/action_type/created_by は不変
 * - status/reviewed_by の更新のみ許す（承認/却下は owner/admin のみ）
 * - delete は grant しない（AI が何を出力したかの事実を消させない）
 * - AI の出力は必ず proposed → 承認で draft のみ反映（published は絶対触らない / 受入 L1124）
 * - structure_change は差分プレビュー→承認を経てから draft に適用（受入 L1125）
 */
export const aiActions = pgTable("ai_actions", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  actionType: aiActionType("action_type").notNull(),
  /** 対象 entity/slug 等（例: "record:therapist:aoi" / "page:home"）。全体提案は null */
  entity: text("entity"),
  /** 依頼内容（プロンプト/対象テキスト/種別など）。不変 */
  request: jsonb("request").notNull(),
  /** AI 出力（提案）。failed の場合は { error: "..." }。不変 */
  output: jsonb("output"),
  /** 審査状態。初期 proposed */
  status: aiActionStatus("status").notNull().default("proposed"),
  createdBy: uuid("created_by").references(() => appUsers.id, { onDelete: "set null" }),
  reviewedBy: uuid("reviewed_by").references(() => appUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
