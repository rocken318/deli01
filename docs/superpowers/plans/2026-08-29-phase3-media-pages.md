# Phase 3: Media Library, Site Settings, Fixed Pages, Blocks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable editing the top-page hero headline and image from the CMS (spec phase 3 completion condition).

**Architecture:** Extend existing migrations with `pages` and `media` tables. Gate the dev-session stub behind `ADMIN_DEV_SESSION` env var. Add block types as discriminated union validated by Zod. Provide a storage abstraction with a Supabase skeleton + local stub. Add admin UI routes for settings, pages/blocks, and media. Add a minimal `/admin/preview/home` page to demonstrate end-to-end CMS rendering.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, Drizzle schema types, postgres.js raw SQL, Zod, Tailwind, Vitest (real Postgres integration tests)

---

## File Map

### New files
- `migrations/0003_pages_media.sql` — pages + media tables, RLS, grants
- `src/domain/cms/blocks.ts` — block discriminated union + Zod schemas
- `src/domain/cms/banned-words.ts` — pure `checkBannedWords` function
- `src/lib/media/storage.ts` — MediaStorage interface + Supabase impl skeleton + local stub
- `src/lib/cms/site-settings-actions.ts` — saveSiteSetting server action
- `src/lib/cms/terminology-actions.ts` — saveTerminology server action
- `src/lib/cms/pages-actions.ts` — savePage, publishPage, saveBlocks server actions
- `src/lib/cms/media-actions.ts` — upsertMediaMeta server action
- `src/app/(admin)/admin/settings/page.tsx` — site settings + terminology UI
- `src/app/(admin)/admin/settings/actions.ts` — re-export server actions
- `src/app/(admin)/admin/pages/page.tsx` — page list
- `src/app/(admin)/admin/pages/[slug]/page.tsx` — block editor
- `src/app/(admin)/admin/pages/[slug]/actions.ts` — re-export
- `src/app/(admin)/admin/media/page.tsx` — media library list + alt editor
- `src/app/(admin)/admin/preview/home/page.tsx` — minimal preview renderer
- `tests/unit/blocks.test.ts` — Zod block validation unit tests
- `tests/unit/banned-words.test.ts` — pure function unit tests
- `tests/integration/auth-rls.test.ts` — extend with pages + media RLS cases

### Modified files
- `src/lib/cms/dev-session.ts` — gate behind `ADMIN_DEV_SESSION` env var
- `src/lib/env.ts` — add `adminDevSession` getter
- `.env` — add `ADMIN_DEV_SESSION=1`
- `.env.example` — document `ADMIN_DEV_SESSION`
- `src/db/schema.ts` — add `pages` and `media` Drizzle table types
- `scripts/seed.ts` — add pages + media seed rows
- `src/app/(admin)/layout.tsx` — add nav items for settings, pages, media

---

## Task 1: Gate dev-session behind ADMIN_DEV_SESSION

**Files:**
- Modify: `src/lib/cms/dev-session.ts`
- Modify: `src/lib/env.ts`
- Modify: `.env`
- Modify: `.env.example`

- [ ] **Step 1: Add env var getter to `src/lib/env.ts`**

After the existing `openaiApiKey` line, add:

```typescript
  /** 開発専用セッションスタブ有効化フラグ。本番では絶対に設定しない（spec フェーズ3 優先度0） */
  adminDevSession: read("ADMIN_DEV_SESSION"),
```

- [ ] **Step 2: Edit `src/lib/cms/dev-session.ts`**

Replace the entire file content:

```typescript
import "server-only";
import type { Session } from "@/lib/auth/session";
import { env } from "@/lib/env";

/**
 * 開発・デモ用のセッション取得（フェーズ2〜3）。
 *
 * 【暫定措置】live Supabase Auth 配線（フェーズ1後半〜）までの間、
 * 環境変数 ADMIN_DEV_SESSION=1 が設定されている場合のみシードの owner を返す。
 * 未設定（本番・プレビュー）では null を返し、全アクション・ページは 403 相当になる。
 *
 * TODO(live 配線フェーズ): src/lib/auth/index.ts の getDefaultSessionProvider() に差し替える。
 * 本番環境では ADMIN_DEV_SESSION を絶対に設定しないこと。
 */
export async function getDevSession(): Promise<Session | null> {
  if (!env.adminDevSession) {
    return null;
  }
  // シードで投入した owner の id（scripts/seed.ts の appUsers 参照）
  return {
    userId: "aaaaaaaa-0000-4000-8000-000000000001",
    role: "owner",
  };
}
```

- [ ] **Step 3: Add to `.env.example`**

After the `SMTP_URL=""` line, add:

```
# 開発専用セッションスタブ（フェーズ3 優先度0）
# ローカル開発時のみ 1 を設定する。本番・プレビュー環境では絶対に設定しない。
# live Supabase Auth 配線後は削除する。
ADMIN_DEV_SESSION=""
```

- [ ] **Step 4: Set in `.env` (local only — never commit)**

Add to `.env`:
```
ADMIN_DEV_SESSION=1
```

- [ ] **Step 5: Verify existing actions return 403-equivalent when session is null**

The pattern already exists in every action in `src/lib/cms/actions.ts`:
```typescript
const session = await getDevSession();
if (!session) return { ok: false, error: "認証が必要です" };
```
No code changes needed — the gate in `getDevSession` is sufficient.

- [ ] **Step 6: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/lib/cms/dev-session.ts src/lib/env.ts .env.example
git commit -m "security: gate dev-session stub behind ADMIN_DEV_SESSION env var"
```

---

## Task 2: Migration — pages and media tables

**Files:**
- Create: `migrations/0003_pages_media.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 0003_pages_media: 固定ページ + メディアライブラリ（フェーズ3 / spec 3-6・3-7）
--
-- RLS 必須セット（docs/auth-rls.md §4）:
--   enable row level security
--   force row level security
--   ポリシー
--   app_runtime への grant

-- ---------------------------------------------------------------------------
-- face_visibility enum（spec 3-7: 顔出し可否）
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'face_visibility') then
    create type face_visibility as enum ('face', 'eyes', 'none');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- media: メディアライブラリ（spec 3-7）
-- ---------------------------------------------------------------------------
create table if not exists media (
  id              uuid primary key default gen_random_uuid(),
  storage_path    text not null default '',      -- Supabase Storage のパス（未配線時は空）
  url             text not null default '',      -- 配信 URL（未配線時は空）
  mime            text not null default 'image/webp',
  width           integer,
  height          integer,
  alt             text not null,                 -- 必須（spec 3-7: alt 未入力では公開不可）
  tags            text[] not null default '{}',  -- 'placeholder' タグで未差替を追える
  consent_flag    boolean not null default false,
  consent_date    date,
  face_visibility face_visibility not null default 'none',
  is_placeholder  boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists media_set_updated_at on media;
create trigger media_set_updated_at
  before update on media
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- pages: 固定ページ（spec 3-6）
-- フィールド定義テーブル + JSONB 方式を再利用（entity='page'）。
-- ブロックは blocks jsonb カラムに配列として格納する。
-- draft_fields/published_fields: ページ固有フィールド（見出し・リード文・hero_image 等）
-- draft_blocks/published_blocks: ブロック配列
-- ---------------------------------------------------------------------------
create table if not exists pages (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null,
  locale           text not null default 'ja',
  draft_fields     jsonb not null default '{}',
  published_fields jsonb,
  draft_blocks     jsonb not null default '[]',
  published_blocks jsonb,
  published_at     timestamptz,
  seo_title        text,
  seo_description  text,
  seo_ogp_image_id uuid references media (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint pages_slug_locale_unique unique (slug, locale)
);

create index if not exists pages_slug_idx on pages (slug, locale);

drop trigger if exists pages_set_updated_at on pages;
create trigger pages_set_updated_at
  before update on pages
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- banned_words: 禁止語リスト（spec 13-2）
-- ---------------------------------------------------------------------------
create table if not exists banned_words (
  id         uuid primary key default gen_random_uuid(),
  word       text not null unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: media
-- owner/admin: 全操作
-- reception: select のみ（コース・ページ画像を参照する可能性）
-- therapist: select のみ（自分のプロフィール画像参照）
-- public（未セッション）: select のみ（公開ページが参照する）
-- ---------------------------------------------------------------------------
alter table media enable row level security;
alter table media force row level security;

drop policy if exists media_select on media;
create policy media_select on media
  for select using (true);

drop policy if exists media_write on media;
create policy media_write on media
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- ---------------------------------------------------------------------------
-- RLS: pages
-- owner/admin: 全操作
-- reception: select のみ
-- therapist: アクセス不可
-- ---------------------------------------------------------------------------
alter table pages enable row level security;
alter table pages force row level security;

drop policy if exists pages_owner_admin on pages;
create policy pages_owner_admin on pages
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists pages_reception_select on pages;
create policy pages_reception_select on pages
  for select using (app_current_role() = 'reception');

-- ---------------------------------------------------------------------------
-- RLS: banned_words
-- owner/admin: 全操作
-- 他: select のみ（公開時の禁止語チェックに参照する）
-- ---------------------------------------------------------------------------
alter table banned_words enable row level security;
alter table banned_words force row level security;

drop policy if exists banned_words_select on banned_words;
create policy banned_words_select on banned_words
  for select using (true);

drop policy if exists banned_words_write on banned_words;
create policy banned_words_write on banned_words
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- ---------------------------------------------------------------------------
-- app_runtime への grant
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on media to app_runtime;
grant select, insert, update, delete on pages to app_runtime;
grant select, insert, update, delete on banned_words to app_runtime;
```

- [ ] **Step 2: Run migration**

```bash
pnpm db:migrate
```
Expected: Migration applied without error.

- [ ] **Step 3: Commit**

```bash
git add migrations/0003_pages_media.sql
git commit -m "feat: add pages, media, banned_words tables with RLS (phase 3)"
```

---

## Task 3: Drizzle schema types for new tables

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add imports and new table definitions**

At the top of `src/db/schema.ts`, add `pgEnum` is already imported. Add `date` to imports (it's already there as `timestamp`). Add the following after `auditLogs`:

```typescript
/** face_visibility enum（spec 3-7: セラピスト写真の顔出し可否） */
export const faceVisibility = pgEnum("face_visibility", ["face", "eyes", "none"]);

/**
 * メディアライブラリ（spec 3-7）。
 * alt は必須（未入力では公開不可）。
 * storage_path / url は Supabase Storage 配線後に埋まる（未配線時は空文字）。
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
  consentDate: text("consent_date"), // date as text (YYYY-MM-DD)
  faceVisibility: faceVisibility("face_visibility").notNull().default("none"),
  isPlaceholder: boolean("is_placeholder").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 固定ページ（spec 3-6）。
 * draft_fields/draft_blocks: 編集中。
 * published_fields/published_blocks: 公開中（null なら未公開）。
 * ブロックは src/domain/cms/blocks.ts の Block[] 型で格納する。
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
  word: text("word").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat: add Drizzle schema types for media, pages, banned_words"
```

---

## Task 4: Block discriminated union and Zod validation

**Files:**
- Create: `src/domain/cms/blocks.ts`
- Create: `tests/unit/blocks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/blocks.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  blockSchema,
  blocksArraySchema,
  BLOCK_TYPES,
  type Block,
} from "@/domain/cms/blocks";

describe("blockSchema", () => {
  it("hero ブロックが valid になる", () => {
    const input = {
      id: "b1",
      type: "hero",
      visible: true,
      heading: "ようこそ",
      subheading: "リラクゼーションサービス",
      imageId: null,
      ctaLabel: "予約する",
      ctaHref: "/booking",
    };
    const result = blockSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("text ブロックが valid になる", () => {
    const input = { id: "b2", type: "text", visible: true, body: "テキスト" };
    expect(blockSchema.safeParse(input).success).toBe(true);
  });

  it("image ブロックが valid になる", () => {
    const input = { id: "b3", type: "image", visible: true, imageId: "uuid-1", alt: "説明" };
    expect(blockSchema.safeParse(input).success).toBe(true);
  });

  it("ホワイトリスト外の type は invalid になる", () => {
    const input = { id: "b4", type: "custom_unknown", visible: true };
    expect(blockSchema.safeParse(input).success).toBe(false);
  });

  it("id が無いブロックは invalid", () => {
    const input = { type: "hero", visible: true, heading: "h" };
    expect(blockSchema.safeParse(input).success).toBe(false);
  });

  it("blocksArraySchema でブロック配列を検証できる", () => {
    const arr = [
      { id: "b1", type: "hero", visible: true, heading: "h" },
      { id: "b2", type: "text", visible: false, body: "t" },
    ];
    expect(blocksArraySchema.safeParse(arr).success).toBe(true);
  });

  it("BLOCK_TYPES には hero/text/image 等 10 種が含まれる", () => {
    expect(BLOCK_TYPES).toContain("hero");
    expect(BLOCK_TYPES).toContain("text");
    expect(BLOCK_TYPES).toContain("image");
    expect(BLOCK_TYPES.length).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm test tests/unit/blocks.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/domain/cms/blocks.ts`**

```typescript
/**
 * CMS ブロック型（spec 3-6）。
 *
 * ブロックはホワイトリスト限定（10種）。幅・色・フォントは選ばせない。
 * 各ブロックは id（クライアント生成の UUID）・type・visible を共通で持ち、
 * type によって判別できる discriminated union になっている。
 *
 * DB には pages.draft_blocks / published_blocks の jsonb[] として格納する。
 */

import { z } from "zod";

/** ホワイトリスト（spec 3-6: これ以上は増やさない） */
export const BLOCK_TYPES = [
  "hero",
  "text",
  "image",
  "text_image",
  "therapist_picks",
  "course_list",
  "steps",
  "faq",
  "notice",
  "cta",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

// ---------------------------------------------------------------------------
// 共通フィールド
// ---------------------------------------------------------------------------
const blockBase = z.object({
  /** クライアント生成の UUID（並べ替え・複製の識別子） */
  id: z.string().min(1),
  /** 非表示フラグ（false = 非表示。削除ではなく隠す） */
  visible: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// 各ブロック
// ---------------------------------------------------------------------------
export const heroBlockSchema = blockBase.extend({
  type: z.literal("hero"),
  heading: z.string().default(""),
  subheading: z.string().default(""),
  /** media.id への参照（null = 未設定） */
  imageId: z.string().nullable().default(null),
  ctaLabel: z.string().default(""),
  ctaHref: z.string().default(""),
});

export const textBlockSchema = blockBase.extend({
  type: z.literal("text"),
  body: z.string().default(""),
});

export const imageBlockSchema = blockBase.extend({
  type: z.literal("image"),
  imageId: z.string().nullable().default(null),
  alt: z.string().default(""),
  caption: z.string().default(""),
});

export const textImageBlockSchema = blockBase.extend({
  type: z.literal("text_image"),
  body: z.string().default(""),
  imageId: z.string().nullable().default(null),
  imagePosition: z.enum(["left", "right"]).default("right"),
  alt: z.string().default(""),
});

export const therapistPicksBlockSchema = blockBase.extend({
  type: z.literal("therapist_picks"),
  heading: z.string().default(""),
  /** therapist slug のリスト（最大5件推奨） */
  slugs: z.array(z.string()).default([]),
});

export const courseListBlockSchema = blockBase.extend({
  type: z.literal("course_list"),
  heading: z.string().default(""),
});

export const stepsBlockSchema = blockBase.extend({
  type: z.literal("steps"),
  heading: z.string().default(""),
  items: z.array(z.object({ label: z.string(), body: z.string() })).default([]),
});

export const faqBlockSchema = blockBase.extend({
  type: z.literal("faq"),
  heading: z.string().default(""),
  items: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
});

export const noticeBlockSchema = blockBase.extend({
  type: z.literal("notice"),
  body: z.string().default(""),
});

export const ctaBlockSchema = blockBase.extend({
  type: z.literal("cta"),
  label: z.string().default(""),
  href: z.string().default(""),
  subtext: z.string().default(""),
});

// ---------------------------------------------------------------------------
// 判別可能 union（discriminator: type）
// ---------------------------------------------------------------------------
export const blockSchema = z.discriminatedUnion("type", [
  heroBlockSchema,
  textBlockSchema,
  imageBlockSchema,
  textImageBlockSchema,
  therapistPicksBlockSchema,
  courseListBlockSchema,
  stepsBlockSchema,
  faqBlockSchema,
  noticeBlockSchema,
  ctaBlockSchema,
]);

export const blocksArraySchema = z.array(blockSchema);

// ---------------------------------------------------------------------------
// 型エクスポート
// ---------------------------------------------------------------------------
export type HeroBlock = z.infer<typeof heroBlockSchema>;
export type TextBlock = z.infer<typeof textBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type TextImageBlock = z.infer<typeof textImageBlockSchema>;
export type TherapistPicksBlock = z.infer<typeof therapistPicksBlockSchema>;
export type CourseListBlock = z.infer<typeof courseListBlockSchema>;
export type StepsBlock = z.infer<typeof stepsBlockSchema>;
export type FaqBlock = z.infer<typeof faqBlockSchema>;
export type NoticeBlock = z.infer<typeof noticeBlockSchema>;
export type CtaBlock = z.infer<typeof ctaBlockSchema>;
export type Block = z.infer<typeof blockSchema>;
```

- [ ] **Step 4: Run tests**

```bash
pnpm test tests/unit/blocks.test.ts
```
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/cms/blocks.ts tests/unit/blocks.test.ts
git commit -m "feat: block discriminated union with Zod validation (spec 3-6)"
```

---

## Task 5: Banned words pure function + tests

**Files:**
- Create: `src/domain/cms/banned-words.ts`
- Create: `tests/unit/banned-words.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/banned-words.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { checkBannedWords } from "@/domain/cms/banned-words";

describe("checkBannedWords", () => {
  it("禁止語が含まれていない場合は空配列を返す", () => {
    expect(checkBannedWords("ボディケアで疲れを癒します", ["治療", "治る"])).toEqual([]);
  });

  it("禁止語が含まれる場合、マッチした語のリストを返す", () => {
    const result = checkBannedWords("肩こりが治ります。治療効果があります", ["治ります", "治療", "効果"]);
    expect(result).toContain("治ります");
    expect(result).toContain("治療");
    expect(result).toContain("効果");
    expect(result.length).toBe(3);
  });

  it("大文字小文字を区別せずにチェックする", () => {
    const result = checkBannedWords("Medical effect", ["medical"]);
    expect(result).toContain("medical");
  });

  it("同じ禁止語が複数回出てきても1件だけ返す（重複なし）", () => {
    const result = checkBannedWords("治る治る", ["治る"]);
    expect(result.length).toBe(1);
  });

  it("禁止語リストが空の場合は常に空配列", () => {
    expect(checkBannedWords("何でも書ける", [])).toEqual([]);
  });

  it("テキストが空文字の場合は空配列", () => {
    expect(checkBannedWords("", ["治る"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
pnpm test tests/unit/banned-words.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement `src/domain/cms/banned-words.ts`**

```typescript
/**
 * 禁止語チェック（spec 13-2）。DB にも Next.js にも依存しない純粋関数。
 *
 * 公開ボタンを押したときに呼び出し、マッチした禁止語の一覧を返す。
 * ブロックはしない（警告のみ。運営が判断して公開できる）。
 */

/**
 * @param text - チェック対象のテキスト
 * @param list - 禁止語のリスト（CMS から取得した banned_words.word[]）
 * @returns マッチした禁止語のリスト（重複なし）。0件なら安全。
 */
export function checkBannedWords(text: string, list: string[]): string[] {
  if (!text || list.length === 0) return [];
  const lower = text.toLowerCase();
  const matched = new Set<string>();
  for (const word of list) {
    if (word && lower.includes(word.toLowerCase())) {
      matched.add(word);
    }
  }
  return Array.from(matched);
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test tests/unit/banned-words.test.ts
```
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/cms/banned-words.ts tests/unit/banned-words.test.ts
git commit -m "feat: checkBannedWords pure function + unit tests (spec 13-2)"
```

---

## Task 6: Media storage abstraction

**Files:**
- Create: `src/lib/media/storage.ts`

- [ ] **Step 1: Create the file**

```typescript
/**
 * メディアストレージ抽象化（spec 3-7）。
 *
 * ストレージは抽象化する。Supabase Storage の live 配線前でも
 * 開発・テストが回るよう、ローカルスタブを提供する。
 *
 * TODO(Supabase Storage 配線フェーズ): SupabaseMediaStorage の TODO 箇所を実装する。
 *   env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要。
 */

import { env } from "@/lib/env";

export interface UploadResult {
  storagePath: string;
  url: string;
}

/** メディアストレージインターフェース */
export interface MediaStorage {
  /**
   * ファイルをアップロードし、storage_path と公開 URL を返す。
   * @param path - バケット内のパス（例: "media/2026/08/image.webp"）
   * @param buffer - ファイルの Buffer
   * @param mime - MIME タイプ
   */
  upload(path: string, buffer: Buffer, mime: string): Promise<UploadResult>;

  /**
   * ファイルを削除する。
   * @param path - バケット内のパス
   */
  delete(path: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Supabase Storage 実装（スケルトン）
// NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要。
// ---------------------------------------------------------------------------
class SupabaseMediaStorage implements MediaStorage {
  private readonly bucketName = "media";

  async upload(path: string, buffer: Buffer, mime: string): Promise<UploadResult> {
    const supabaseUrl = env.supabaseUrl;
    const serviceRoleKey = env.supabaseServiceRoleKey;

    if (!supabaseUrl || !serviceRoleKey) {
      // TODO(Supabase Storage 配線フェーズ): env を必須にしてエラーにする。
      // 現在は未配線のため、ローカルスタブにフォールバックする。
      console.warn("[MediaStorage] Supabase env not set — falling back to local stub");
      return localStorageStub.upload(path, buffer, mime);
    }

    // TODO(Supabase Storage 配線フェーズ): @supabase/storage-js を使って実装する。
    // 実装例:
    //   const storage = new StorageClient(`${supabaseUrl}/storage/v1`, {
    //     apikey: serviceRoleKey,
    //     Authorization: `Bearer ${serviceRoleKey}`,
    //   });
    //   const { data, error } = await storage.from(this.bucketName).upload(path, buffer, { contentType: mime });
    //   if (error) throw error;
    //   const { data: { publicUrl } } = storage.from(this.bucketName).getPublicUrl(path);
    //   return { storagePath: path, url: publicUrl };
    throw new Error("Supabase Storage 未実装。TODO を参照してください。");
  }

  async delete(path: string): Promise<void> {
    const supabaseUrl = env.supabaseUrl;
    const serviceRoleKey = env.supabaseServiceRoleKey;
    if (!supabaseUrl || !serviceRoleKey) {
      return; // スタブ: 何もしない
    }
    // TODO(Supabase Storage 配線フェーズ): 削除を実装する。
    void path;
    throw new Error("Supabase Storage 削除: 未実装。TODO を参照してください。");
  }
}

// ---------------------------------------------------------------------------
// ローカル / インメモリスタブ（開発・テスト用）
// 実ファイルは保存しない。storagePath と url を返すだけ。
// ---------------------------------------------------------------------------
const localStorageStub: MediaStorage = {
  async upload(path: string, _buffer: Buffer, _mime: string): Promise<UploadResult> {
    // 開発時は /public/placeholder.svg 等を直接参照する想定。
    return { storagePath: path, url: "" };
  },
  async delete(_path: string): Promise<void> {
    // no-op
  },
};

// ---------------------------------------------------------------------------
// シングルトン（アプリ起動時に1つだけ生成）
// ---------------------------------------------------------------------------
export const mediaStorage: MediaStorage = new SupabaseMediaStorage();
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/media/storage.ts
git commit -m "feat: MediaStorage interface + Supabase skeleton + local stub (spec 3-7)"
```

---

## Task 7: Server actions — site settings and terminology

**Files:**
- Create: `src/lib/cms/site-settings-actions.ts`
- Create: `src/lib/cms/terminology-actions.ts`

- [ ] **Step 1: Create `src/lib/cms/site-settings-actions.ts`**

```typescript
"use server";

/**
 * サイト設定（グローバル / spec 3-6）の Server Actions。
 * owner/admin のみ実行可能。withUser + audit_logs。
 */

import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import type { ActionResult } from "@/lib/cms/actions";

const saveSettingSchema = z.object({
  key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, "key は小文字英数字とアンダースコアのみ"),
  value: z.unknown(),
});

/**
 * サイト設定を1件保存（upsert）する（owner/admin のみ）。
 */
export async function saveSiteSetting(
  key: string,
  value: unknown,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = saveSettingSchema.safeParse({ key, value });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      const existing = await tx<{ value: unknown }[]>`
        select value from site_settings where key = ${parsed.data.key}
      `;
      const before = existing[0]?.value ?? null;

      await tx`
        insert into site_settings (key, value)
        values (${parsed.data.key}, ${JSON.stringify(parsed.data.value)}::jsonb)
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `;

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, before, after)
        values (
          ${session.userId}::uuid,
          'update',
          'site_setting',
          null,
          ${JSON.stringify({ key: parsed.data.key, value: before })}::jsonb,
          ${JSON.stringify({ key: parsed.data.key, value: parsed.data.value })}::jsonb
        )
      `;
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

/**
 * 全サイト設定をオブジェクトとして取得する（公開可能 / RLS で全員 select 可）。
 */
export async function getAllSiteSettings(): Promise<Record<string, unknown>> {
  const sql = getClient();
  const rows = await sql<{ key: string; value: unknown }[]>`
    select key, value from site_settings
  `;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
```

- [ ] **Step 2: Create `src/lib/cms/terminology-actions.ts`**

```typescript
"use server";

/**
 * 用語辞書（spec 13-1）の Server Actions。
 * owner/admin のみ実行可能。withUser + audit_logs。
 */

import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import type { ActionResult } from "@/lib/cms/actions";

const saveTermSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  locale: z.string().default("ja"),
});

/**
 * 用語辞書を1件保存（upsert）する（owner/admin のみ）。
 */
export async function saveTerminology(
  key: string,
  value: string,
  locale = "ja",
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = saveTermSchema.safeParse({ key, value, locale });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      await tx`
        insert into terminology (key, value, locale)
        values (${parsed.data.key}, ${parsed.data.value}, ${parsed.data.locale})
        on conflict (key, locale) do update set value = excluded.value, updated_at = now()
      `;

      await tx`
        insert into audit_logs (actor_user_id, action, entity, after)
        values (
          ${session.userId}::uuid,
          'update',
          'terminology',
          ${JSON.stringify(parsed.data)}::jsonb
        )
      `;
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

/**
 * 用語辞書を全件取得（locale 指定、公開ページが参照）。
 */
export async function getAllTerminology(locale = "ja"): Promise<Record<string, string>> {
  const sql = getClient();
  const rows = await sql<{ key: string; value: string }[]>`
    select key, value from terminology where locale = ${locale}
  `;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/cms/site-settings-actions.ts src/lib/cms/terminology-actions.ts
git commit -m "feat: saveSiteSetting + saveTerminology server actions (spec 3-6, 13-1)"
```

---

## Task 8: Server actions — pages and blocks

**Files:**
- Create: `src/lib/cms/pages-actions.ts`

- [ ] **Step 1: Create `src/lib/cms/pages-actions.ts`**

```typescript
"use server";

/**
 * 固定ページ + ブロック（spec 3-6）の Server Actions。
 * owner/admin のみ実行可能。withUser + audit_logs。
 * 公開時に禁止語チェック（警告のみ / spec 13-2）。
 */

import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import { blocksArraySchema, type Block } from "@/domain/cms/blocks";
import { checkBannedWords } from "@/domain/cms/banned-words";
import type { ActionResult } from "@/lib/cms/actions";

const pageFieldsSchema = z.object({
  heading: z.string().default(""),
  lead: z.string().default(""),
  heroImageId: z.string().nullable().default(null),
  seoTitle: z.string().default(""),
  seoDescription: z.string().default(""),
});

export type PageFields = z.infer<typeof pageFieldsSchema>;

/**
 * ページの draft_fields を保存する（upsert）。
 */
export async function savePageFields(
  slug: string,
  fields: PageFields,
  locale = "ja",
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsedSlug = z.string().min(1).regex(/^[a-z0-9-]+$/).safeParse(slug);
  if (!parsedSlug.success) return { ok: false, error: "slug が不正です" };

  const parsedFields = pageFieldsSchema.safeParse(fields);
  if (!parsedFields.success) {
    return { ok: false, error: parsedFields.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into pages (slug, locale, draft_fields)
        values (${slug}, ${locale}, ${JSON.stringify(parsedFields.data)}::jsonb)
        on conflict (slug, locale) do update
          set draft_fields = excluded.draft_fields,
              updated_at   = now()
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error("upsert failed");

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid, 'update', 'page', ${row.id}::uuid,
          ${JSON.stringify({ slug, locale })}::jsonb
        )
      `;
      return { id: row.id };
    });

    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

/**
 * ページの draft_blocks を保存する。
 */
export async function savePageBlocks(
  slug: string,
  blocks: Block[],
  locale = "ja",
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsedBlocks = blocksArraySchema.safeParse(blocks);
  if (!parsedBlocks.success) {
    return { ok: false, error: parsedBlocks.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      await tx`
        insert into pages (slug, locale, draft_blocks)
        values (${slug}, ${locale}, ${JSON.stringify(parsedBlocks.data)}::jsonb)
        on conflict (slug, locale) do update
          set draft_blocks = excluded.draft_blocks,
              updated_at   = now()
      `;

      await tx`
        insert into audit_logs (actor_user_id, action, entity, after)
        values (
          ${session.userId}::uuid, 'update', 'page_blocks',
          ${JSON.stringify({ slug, locale, count: parsedBlocks.data.length })}::jsonb
        )
      `;
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

export interface PublishPageResult {
  warnings: string[];
}

/**
 * ページを公開する（draft → published）。
 * 禁止語チェックを行い、マッチがあれば warnings に入れて返す（ブロックしない）。
 */
export async function publishPage(
  slug: string,
  locale = "ja",
): Promise<ActionResult<PublishPageResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const sql = getClient();

  try {
    return await withUser(sql, session, async (tx): Promise<ActionResult<PublishPageResult>> => {
      const rows = await tx<{
        id: string;
        draft_fields: Record<string, unknown>;
        draft_blocks: unknown[];
      }[]>`
        select id, draft_fields, draft_blocks
        from pages where slug = ${slug} and locale = ${locale}
      `;
      const page = rows[0];
      if (!page) return { ok: false, error: "ページが見つかりません" };

      // 禁止語チェック（spec 13-2）
      const wordRows = await tx<{ word: string }[]>`select word from banned_words`;
      const wordList = wordRows.map((r) => r.word);
      const allText = JSON.stringify(page.draft_fields) + " " + JSON.stringify(page.draft_blocks);
      const warnings = checkBannedWords(allText, wordList).map((w) => `禁止語「${w}」が含まれています`);

      await tx`
        update pages
        set published_fields = draft_fields,
            published_blocks = draft_blocks,
            published_at = now()
        where id = ${page.id}::uuid
      `;

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id)
        values (${session.userId}::uuid, 'publish', 'page', ${page.id}::uuid)
      `;

      return { ok: true, data: { warnings } };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

/**
 * ページ一覧を取得する（管理画面用）。
 */
export async function listPages(locale = "ja"): Promise<
  { id: string; slug: string; publishedAt: string | null; updatedAt: string }[]
> {
  const sql = getClient();
  const rows = await sql<{
    id: string;
    slug: string;
    published_at: string | null;
    updated_at: string;
  }[]>`
    select id, slug, published_at, updated_at
    from pages where locale = ${locale}
    order by slug
  `;
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * ページ詳細を1件取得する（管理画面用）。
 */
export async function getPage(slug: string, locale = "ja"): Promise<{
  id: string;
  slug: string;
  draftFields: Record<string, unknown>;
  publishedFields: Record<string, unknown> | null;
  draftBlocks: Block[];
  publishedBlocks: Block[] | null;
  publishedAt: string | null;
} | null> {
  const sql = getClient();
  const rows = await sql<{
    id: string;
    slug: string;
    draft_fields: Record<string, unknown>;
    published_fields: Record<string, unknown> | null;
    draft_blocks: unknown;
    published_blocks: unknown | null;
    published_at: string | null;
  }[]>`
    select id, slug, draft_fields, published_fields, draft_blocks, published_blocks, published_at
    from pages where slug = ${slug} and locale = ${locale}
  `;
  const row = rows[0];
  if (!row) return null;

  const draftBlocks = blocksArraySchema.parse(row.draft_blocks ?? []);
  const publishedBlocks = row.published_blocks
    ? blocksArraySchema.parse(row.published_blocks)
    : null;

  return {
    id: row.id,
    slug: row.slug,
    draftFields: row.draft_fields,
    publishedFields: row.published_fields,
    draftBlocks,
    publishedBlocks,
    publishedAt: row.published_at,
  };
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/cms/pages-actions.ts
git commit -m "feat: savePageFields, savePageBlocks, publishPage server actions (spec 3-6)"
```

---

## Task 9: Server actions — media metadata

**Files:**
- Create: `src/lib/cms/media-actions.ts`

- [ ] **Step 1: Create `src/lib/cms/media-actions.ts`**

```typescript
"use server";

/**
 * メディアライブラリ（spec 3-7）の Server Actions。
 * owner/admin のみ書き込み可能。
 */

import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import type { ActionResult } from "@/lib/cms/actions";

const upsertMediaSchema = z.object({
  id: z.string().uuid().optional(),
  storagePath: z.string().default(""),
  url: z.string().default(""),
  mime: z.string().default("image/webp"),
  width: z.number().int().positive().optional().nullable(),
  height: z.number().int().positive().optional().nullable(),
  alt: z.string().min(1, "alt テキストは必須です（spec 3-7）"),
  tags: z.array(z.string()).default([]),
  consentFlag: z.boolean().default(false),
  consentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  faceVisibility: z.enum(["face", "eyes", "none"]).default("none"),
  isPlaceholder: z.boolean().default(false),
});

export type UpsertMediaInput = z.infer<typeof upsertMediaSchema>;

/**
 * メディアメタデータを保存する（insert or update）。
 * alt は必須（spec 3-7: alt 未入力では公開不可）。
 */
export async function upsertMediaMeta(
  input: UpsertMediaInput,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = upsertMediaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const data = parsed.data;
  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      if (data.id) {
        // update
        await tx`
          update media set
            storage_path    = ${data.storagePath},
            url             = ${data.url},
            mime            = ${data.mime},
            width           = ${data.width ?? null},
            height          = ${data.height ?? null},
            alt             = ${data.alt},
            tags            = ${data.tags}::text[],
            consent_flag    = ${data.consentFlag},
            consent_date    = ${data.consentDate ?? null},
            face_visibility = ${data.faceVisibility}::face_visibility,
            is_placeholder  = ${data.isPlaceholder}
          where id = ${data.id}::uuid
        `;
        await tx`
          insert into audit_logs (actor_user_id, action, entity, entity_id, after)
          values (
            ${session.userId}::uuid, 'update', 'media', ${data.id}::uuid,
            ${JSON.stringify({ alt: data.alt, tags: data.tags })}::jsonb
          )
        `;
        return { id: data.id };
      } else {
        // insert
        const rows = await tx<{ id: string }[]>`
          insert into media
            (storage_path, url, mime, width, height, alt, tags, consent_flag,
             consent_date, face_visibility, is_placeholder)
          values (
            ${data.storagePath}, ${data.url}, ${data.mime},
            ${data.width ?? null}, ${data.height ?? null},
            ${data.alt}, ${data.tags}::text[], ${data.consentFlag},
            ${data.consentDate ?? null}, ${data.faceVisibility}::face_visibility,
            ${data.isPlaceholder}
          )
          returning id
        `;
        const row = rows[0];
        if (!row) throw new Error("insert failed");
        await tx`
          insert into audit_logs (actor_user_id, action, entity, entity_id, after)
          values (
            ${session.userId}::uuid, 'create', 'media', ${row.id}::uuid,
            ${JSON.stringify({ alt: data.alt, tags: data.tags })}::jsonb
          )
        `;
        return { id: row.id };
      }
    });

    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

/**
 * メディア一覧を取得する（管理画面用）。
 */
export async function listMedia(opts: {
  tag?: string;
  isPlaceholder?: boolean;
} = {}): Promise<{
  id: string;
  url: string;
  alt: string;
  tags: string[];
  isPlaceholder: boolean;
  consentFlag: boolean;
  createdAt: string;
}[]> {
  const sql = getClient();

  if (opts.tag !== undefined) {
    const rows = await sql<{
      id: string; url: string; alt: string; tags: string[];
      is_placeholder: boolean; consent_flag: boolean; created_at: string;
    }[]>`
      select id, url, alt, tags, is_placeholder, consent_flag, created_at
      from media
      where ${opts.tag}::text = any(tags)
      order by created_at desc
    `;
    return rows.map((r) => ({
      id: r.id, url: r.url, alt: r.alt, tags: r.tags,
      isPlaceholder: r.is_placeholder, consentFlag: r.consent_flag, createdAt: r.created_at,
    }));
  }

  if (opts.isPlaceholder !== undefined) {
    const rows = await sql<{
      id: string; url: string; alt: string; tags: string[];
      is_placeholder: boolean; consent_flag: boolean; created_at: string;
    }[]>`
      select id, url, alt, tags, is_placeholder, consent_flag, created_at
      from media
      where is_placeholder = ${opts.isPlaceholder}
      order by created_at desc
    `;
    return rows.map((r) => ({
      id: r.id, url: r.url, alt: r.alt, tags: r.tags,
      isPlaceholder: r.is_placeholder, consentFlag: r.consent_flag, createdAt: r.created_at,
    }));
  }

  const rows = await sql<{
    id: string; url: string; alt: string; tags: string[];
    is_placeholder: boolean; consent_flag: boolean; created_at: string;
  }[]>`
    select id, url, alt, tags, is_placeholder, consent_flag, created_at
    from media order by created_at desc
  `;
  return rows.map((r) => ({
    id: r.id, url: r.url, alt: r.alt, tags: r.tags,
    isPlaceholder: r.is_placeholder, consentFlag: r.consent_flag, createdAt: r.created_at,
  }));
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/cms/media-actions.ts
git commit -m "feat: upsertMediaMeta + listMedia server actions (spec 3-7)"
```

---

## Task 10: Seed extension — pages, media, banned_words

**Files:**
- Modify: `scripts/seed.ts`

- [ ] **Step 1: Add seed data for pages, media, and banned_words to `scripts/seed.ts`**

Add the following constants before `async function main()`:

```typescript
/** 固定ページの初期値（spec 3-6: slug='home'） */
const pageSeeds: {
  slug: string;
  locale: string;
  draft_fields: Record<string, unknown>;
  draft_blocks: unknown[];
}[] = [
  {
    slug: "home",
    locale: "ja",
    draft_fields: {
      heading: "あなたに合った、癒しの時間を",
      lead: "出張リラクゼーションで、ご自宅やホテルにお伺いします。",
      heroImageId: null,
      seoTitle: "出張リラクゼーション | トップページ",
      seoDescription: "ご自宅やホテルに出張するリラクゼーションサービスです。",
    },
    draft_blocks: [
      {
        id: "home-hero-1",
        type: "hero",
        visible: true,
        heading: "あなたに合った、癒しの時間を",
        subheading: "出張リラクゼーションで、ご自宅やホテルにお伺いします。",
        imageId: null,
        ctaLabel: "空き枠を確認する",
        ctaHref: "/booking",
      },
      {
        id: "home-cta-1",
        type: "cta",
        visible: true,
        label: "今すぐ予約する",
        href: "/booking",
        subtext: "最短90分でお伺いします",
      },
    ],
  },
];

/** メディアライブラリの初期ダミー（spec 3-7: is_placeholder=true, alt 必須） */
const mediaSeeds: {
  id: string;
  storage_path: string;
  url: string;
  alt: string;
  tags: string[];
  is_placeholder: boolean;
}[] = [
  {
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    storage_path: "",
    url: "",
    alt: "ヒーロー画像プレースホルダー（本番公開前に差し替えること）",
    tags: ["placeholder", "hero"],
    is_placeholder: true,
  },
  {
    id: "bbbbbbbb-0000-4000-8000-000000000002",
    storage_path: "",
    url: "",
    alt: "コース案内画像プレースホルダー（本番公開前に差し替えること）",
    tags: ["placeholder", "course"],
    is_placeholder: true,
  },
  {
    id: "bbbbbbbb-0000-4000-8000-000000000003",
    storage_path: "",
    url: "",
    alt: "セラピストシルエットプレースホルダー（実在人物写真は使用不可 / spec 3-7）",
    tags: ["placeholder", "therapist"],
    is_placeholder: true,
  },
];

/** 禁止語の初期値（spec 13-2） */
const bannedWordSeeds = [
  "治る",
  "治ります",
  "治療",
  "診断",
  "医療",
  "効果があります",
  "改善します",
  "国家資格",
  "あん摩",
  "マッサージ師",
];
```

Then add the following inside `async function main()` after the `entityRecordSamples` loop:

```typescript
    for (const p of pageSeeds) {
      await sql`
        insert into pages (slug, locale, draft_fields, draft_blocks)
        values (
          ${p.slug}, ${p.locale},
          ${JSON.stringify(p.draft_fields)}::jsonb,
          ${JSON.stringify(p.draft_blocks)}::jsonb
        )
        on conflict (slug, locale) do update
          set draft_fields  = excluded.draft_fields,
              draft_blocks  = excluded.draft_blocks
      `;
    }

    for (const m of mediaSeeds) {
      await sql`
        insert into media (id, storage_path, url, alt, tags, is_placeholder)
        values (
          ${m.id}::uuid, ${m.storage_path}, ${m.url},
          ${m.alt}, ${m.tags}::text[], ${m.is_placeholder}
        )
        on conflict (id) do update
          set alt            = excluded.alt,
              tags           = excluded.tags,
              is_placeholder = excluded.is_placeholder
      `;
    }

    for (const word of bannedWordSeeds) {
      await sql`
        insert into banned_words (word)
        values (${word})
        on conflict (word) do nothing
      `;
    }
```

Also update the final `console.log` to include the new counts.

- [ ] **Step 2: Run reset to verify idempotency**

```bash
pnpm db:reset
```
Expected: completes without error

- [ ] **Step 3: Run reset again to confirm idempotency**

```bash
pnpm db:reset
```
Expected: same output, no duplicate key errors

- [ ] **Step 4: Commit**

```bash
git add scripts/seed.ts
git commit -m "feat: seed pages, media placeholders, banned_words (spec 3-6, 3-7, 13-2)"
```

---

## Task 11: Admin UI — site settings page

**Files:**
- Create: `src/app/(admin)/admin/settings/page.tsx`
- Modify: `src/app/(admin)/layout.tsx`

- [ ] **Step 1: Update nav in layout**

In `src/app/(admin)/layout.tsx`, change `navItems` to:

```typescript
const navItems = [
  { href: "/admin/fields", label: "フィールド定義" },
  { href: "/admin/records", label: "レコード" },
  { href: "/admin/settings", label: "サイト設定" },
  { href: "/admin/pages", label: "固定ページ" },
  { href: "/admin/media", label: "メディア" },
] as const;
```

- [ ] **Step 2: Create `src/app/(admin)/admin/settings/page.tsx`**

```tsx
import { Suspense } from "react";
import { getAllSiteSettings, saveSiteSetting } from "@/lib/cms/site-settings-actions";
import { getAllTerminology, saveTerminology } from "@/lib/cms/terminology-actions";

export const metadata = { title: "サイト設定" };

/** サイト設定フォーム（Server Component + inline Server Action） */
async function SettingsContent() {
  const settings = await getAllSiteSettings();
  const terms = await getAllTerminology();

  async function handleSaveSetting(formData: FormData) {
    "use server";
    const key = formData.get("key") as string;
    const value = formData.get("value") as string;
    await saveSiteSetting(key, value);
  }

  async function handleSaveTerm(formData: FormData) {
    "use server";
    const key = formData.get("key") as string;
    const value = formData.get("value") as string;
    await saveTerminology(key, value);
  }

  const settingFields: { key: string; label: string; type?: string }[] = [
    { key: "brand_name", label: "屋号" },
    { key: "reception_phone", label: "受付電話番号" },
    { key: "reception_hours", label: "受付時間" },
    { key: "footer_note", label: "フッター注記" },
  ];

  const termFields: { key: string; label: string; hint: string }[] = [
    { key: "service_noun", label: "施術の呼称", hint: "例：ボディケア" },
    { key: "staff_noun", label: "担当者の呼称", hint: "例：セラピスト" },
    { key: "session_noun", label: "1回の呼称", hint: "例：コース" },
  ];

  return (
    <div className="space-y-10">
      {/* グローバル設定 */}
      <section>
        <h2 className="text-base font-semibold text-adm-text mb-4 pb-2 border-b border-adm-border">
          グローバル設定
        </h2>
        <div className="space-y-4">
          {settingFields.map((f) => (
            <form key={f.key} action={handleSaveSetting} className="flex items-center gap-3">
              <input type="hidden" name="key" value={f.key} />
              <label className="w-32 text-sm text-adm-text shrink-0">{f.label}</label>
              <input
                name="value"
                type="text"
                defaultValue={String(settings[f.key] ?? "")}
                className="flex-1 px-3 py-1.5 text-sm border border-adm-border rounded bg-adm-surface text-adm-text focus:outline-none focus:border-adm-primary"
                style={{ borderRadius: "4px" }}
              />
              <button
                type="submit"
                className="px-3 py-1.5 text-sm bg-adm-primary text-white rounded"
                style={{ borderRadius: "4px" }}
              >
                保存
              </button>
            </form>
          ))}
        </div>
      </section>

      {/* 用語辞書 */}
      <section>
        <h2 className="text-base font-semibold text-adm-text mb-4 pb-2 border-b border-adm-border">
          用語辞書（spec 13-1）
        </h2>
        <p className="text-xs text-adm-muted mb-4">
          公開ページの呼称を一括変更できます。コードに直書きされた日本語は存在しません。
        </p>
        <div className="space-y-4">
          {termFields.map((f) => (
            <form key={f.key} action={handleSaveTerm} className="flex items-center gap-3">
              <input type="hidden" name="key" value={f.key} />
              <label className="w-32 text-sm text-adm-text shrink-0">
                {f.label}
                <span className="block text-xs text-adm-muted">{f.hint}</span>
              </label>
              <input
                name="value"
                type="text"
                defaultValue={String(terms[f.key] ?? "")}
                className="flex-1 px-3 py-1.5 text-sm border border-adm-border rounded bg-adm-surface text-adm-text focus:outline-none focus:border-adm-primary"
                style={{ borderRadius: "4px" }}
              />
              <button
                type="submit"
                className="px-3 py-1.5 text-sm bg-adm-primary text-white rounded"
                style={{ borderRadius: "4px" }}
              >
                保存
              </button>
            </form>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div>
      <h1 className="text-lg font-semibold text-adm-text mb-6">サイト設定</h1>
      <Suspense fallback={<p className="text-sm text-adm-muted">読み込み中…</p>}>
        <SettingsContent />
      </Suspense>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/app/(admin)/admin/settings/page.tsx src/app/(admin)/layout.tsx
git commit -m "feat: /admin/settings UI for site settings and terminology"
```

---

## Task 12: Admin UI — pages list and block editor

**Files:**
- Create: `src/app/(admin)/admin/pages/page.tsx`
- Create: `src/app/(admin)/admin/pages/[slug]/page.tsx`

- [ ] **Step 1: Create `src/app/(admin)/admin/pages/page.tsx`**

```tsx
import Link from "next/link";
import { listPages } from "@/lib/cms/pages-actions";

export const metadata = { title: "固定ページ" };

export default async function PagesListPage() {
  const pages = await listPages();

  return (
    <div>
      <h1 className="text-lg font-semibold text-adm-text mb-6">固定ページ</h1>
      {pages.length === 0 ? (
        <p className="text-sm text-adm-muted">
          ページがありません。シードを実行してください（<code>pnpm db:seed</code>）。
        </p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-adm-border text-left text-adm-muted">
              <th className="pb-2 pr-4 font-medium">slug</th>
              <th className="pb-2 pr-4 font-medium">公開日時</th>
              <th className="pb-2 font-medium">更新日時</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.id} className="border-b border-adm-border">
                <td className="py-2 pr-4">
                  <Link
                    href={`/admin/pages/${p.slug}`}
                    className="text-adm-primary hover:underline"
                  >
                    {p.slug}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-adm-muted">
                  {p.publishedAt ? new Date(p.publishedAt).toLocaleString("ja-JP") : "未公開"}
                </td>
                <td className="py-2 text-adm-muted">
                  {new Date(p.updatedAt).toLocaleString("ja-JP")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/app/(admin)/admin/pages/[slug]/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { getPage, savePageFields, savePageBlocks, publishPage } from "@/lib/cms/pages-actions";
import type { Block } from "@/domain/cms/blocks";

export const metadata = { title: "ページ編集" };

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function PageEditorPage({ params }: Props) {
  const { slug } = await params;
  const page = await getPage(slug);
  if (!page) notFound();

  const fields = page.draftFields as {
    heading?: string;
    lead?: string;
    heroImageId?: string | null;
    seoTitle?: string;
    seoDescription?: string;
  };

  async function handleSaveFields(formData: FormData) {
    "use server";
    await savePageFields(slug, {
      heading: formData.get("heading") as string,
      lead: formData.get("lead") as string,
      heroImageId: (formData.get("heroImageId") as string) || null,
      seoTitle: formData.get("seoTitle") as string,
      seoDescription: formData.get("seoDescription") as string,
    });
  }

  async function handlePublish() {
    "use server";
    await publishPage(slug);
  }

  const heroBlock = page.draftBlocks.find((b): b is Extract<Block, { type: "hero" }> => b.type === "hero");

  async function handleSaveHeroHeading(formData: FormData) {
    "use server";
    const heading = formData.get("heading") as string;
    const newBlocks = page.draftBlocks.map((b) =>
      b.type === "hero" ? { ...b, heading } : b,
    ) as Block[];
    if (newBlocks.every((b) => b.type !== "hero")) {
      newBlocks.unshift({
        id: "home-hero-1",
        type: "hero",
        visible: true,
        heading,
        subheading: "",
        imageId: null,
        ctaLabel: "",
        ctaHref: "",
      });
    }
    await savePageBlocks(slug, newBlocks);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-adm-text">ページ編集: {slug}</h1>
        <span className="text-sm text-adm-muted">
          {page.publishedAt
            ? `公開中（${new Date(page.publishedAt).toLocaleString("ja-JP")}）`
            : "未公開"}
        </span>
        <form action={handlePublish}>
          <button
            type="submit"
            className="px-4 py-1.5 text-sm bg-adm-primary text-white rounded"
            style={{ borderRadius: "4px" }}
          >
            公開する
          </button>
        </form>
      </div>

      {/* ページフィールド */}
      <section>
        <h2 className="text-base font-semibold text-adm-text mb-4 pb-2 border-b border-adm-border">
          ページフィールド
        </h2>
        <form action={handleSaveFields} className="space-y-4">
          {[
            { name: "heading", label: "見出し", defaultValue: fields.heading ?? "" },
            { name: "lead", label: "リード文", defaultValue: fields.lead ?? "" },
            { name: "heroImageId", label: "ヒーロー画像 ID", defaultValue: fields.heroImageId ?? "" },
            { name: "seoTitle", label: "SEO タイトル", defaultValue: fields.seoTitle ?? "" },
            { name: "seoDescription", label: "SEO 説明", defaultValue: fields.seoDescription ?? "" },
          ].map((f) => (
            <div key={f.name} className="flex items-center gap-3">
              <label className="w-36 text-sm text-adm-text shrink-0">{f.label}</label>
              <input
                name={f.name}
                type="text"
                defaultValue={f.defaultValue}
                className="flex-1 px-3 py-1.5 text-sm border border-adm-border rounded bg-adm-surface text-adm-text focus:outline-none focus:border-adm-primary"
                style={{ borderRadius: "4px" }}
              />
            </div>
          ))}
          <button
            type="submit"
            className="px-4 py-1.5 text-sm bg-adm-primary text-white rounded"
            style={{ borderRadius: "4px" }}
          >
            フィールドを保存
          </button>
        </form>
      </section>

      {/* Hero ブロック見出し（完了条件: トップの見出しをCMSから差し替え） */}
      {heroBlock && (
        <section>
          <h2 className="text-base font-semibold text-adm-text mb-4 pb-2 border-b border-adm-border">
            Hero ブロック（トップ見出し）
          </h2>
          <form action={handleSaveHeroHeading} className="flex items-center gap-3">
            <label className="w-36 text-sm text-adm-text shrink-0">見出しテキスト</label>
            <input
              name="heading"
              type="text"
              defaultValue={heroBlock.heading}
              className="flex-1 px-3 py-1.5 text-sm border border-adm-border rounded bg-adm-surface text-adm-text focus:outline-none focus:border-adm-primary"
              style={{ borderRadius: "4px" }}
            />
            <button
              type="submit"
              className="px-3 py-1.5 text-sm bg-adm-primary text-white rounded"
              style={{ borderRadius: "4px" }}
            >
              保存
            </button>
          </form>
          <p className="text-xs text-adm-muted mt-2">
            ヒーロー画像 ID（media テーブルの id）: {heroBlock.imageId ?? "（未設定）"}
          </p>
        </section>
      )}

      {/* ブロック一覧（確認用） */}
      <section>
        <h2 className="text-base font-semibold text-adm-text mb-4 pb-2 border-b border-adm-border">
          ブロック一覧（下書き / {page.draftBlocks.length} 件）
        </h2>
        {page.draftBlocks.length === 0 ? (
          <p className="text-sm text-adm-muted">ブロックがありません。</p>
        ) : (
          <ul className="space-y-2">
            {page.draftBlocks.map((b, i) => (
              <li
                key={b.id}
                className="flex items-center gap-3 px-3 py-2 bg-adm-surface border border-adm-border rounded"
                style={{ borderRadius: "4px" }}
              >
                <span className="text-xs text-adm-muted w-6">{i + 1}</span>
                <span className="text-xs font-mono bg-adm-bg px-1.5 py-0.5 rounded text-adm-primary">
                  {b.type}
                </span>
                <span className="text-sm text-adm-text">
                  {"heading" in b ? b.heading : "label" in b ? b.label : b.id}
                </span>
                {!b.visible && (
                  <span className="ml-auto text-xs text-adm-caution">非表示</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/app/(admin)/admin/pages/
git commit -m "feat: /admin/pages list and block editor UI (spec 3-6)"
```

---

## Task 13: Admin UI — media library

**Files:**
- Create: `src/app/(admin)/admin/media/page.tsx`

- [ ] **Step 1: Create `src/app/(admin)/admin/media/page.tsx`**

```tsx
import { listMedia, upsertMediaMeta } from "@/lib/cms/media-actions";

export const metadata = { title: "メディアライブラリ" };

export default async function MediaPage() {
  const items = await listMedia();

  async function handleSaveAlt(formData: FormData) {
    "use server";
    const id = formData.get("id") as string;
    const alt = formData.get("alt") as string;
    const tags = (formData.get("tags") as string).split(",").map((t) => t.trim()).filter(Boolean);
    await upsertMediaMeta({
      id,
      alt,
      tags,
      storagePath: "",
      url: "",
      mime: "image/webp",
      isPlaceholder: tags.includes("placeholder"),
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-adm-text">メディアライブラリ</h1>
        <p className="text-xs text-adm-muted">
          alt は必須（未設定では公開不可）。placeholder タグで本番差し替え対象を追えます。
        </p>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-adm-muted">
          メディアがありません。シードを実行してください（<code>pnpm db:seed</code>）。
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <form
              key={item.id}
              action={handleSaveAlt}
              className="flex items-center gap-3 px-4 py-3 bg-adm-surface border border-adm-border rounded"
              style={{ borderRadius: "4px" }}
            >
              <input type="hidden" name="id" value={item.id} />

              {/* URL がある場合は画像表示（開発中は空のため div で代替） */}
              <div className="w-16 h-16 bg-adm-bg border border-adm-border rounded flex items-center justify-center shrink-0">
                {item.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.url} alt={item.alt} className="w-full h-full object-cover rounded" />
                ) : (
                  <span className="text-xs text-adm-muted text-center leading-tight px-1">
                    {item.isPlaceholder ? "PH" : "No img"}
                  </span>
                )}
              </div>

              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-adm-muted w-20 shrink-0">alt テキスト</label>
                  <input
                    name="alt"
                    type="text"
                    defaultValue={item.alt}
                    required
                    className="flex-1 px-2 py-1 text-sm border border-adm-border rounded bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
                    style={{ borderRadius: "4px" }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-adm-muted w-20 shrink-0">タグ（カンマ区切り）</label>
                  <input
                    name="tags"
                    type="text"
                    defaultValue={item.tags.join(", ")}
                    className="flex-1 px-2 py-1 text-sm border border-adm-border rounded bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
                    style={{ borderRadius: "4px" }}
                  />
                </div>
              </div>

              <div className="flex flex-col items-end gap-2 shrink-0">
                <button
                  type="submit"
                  className="px-3 py-1.5 text-xs bg-adm-primary text-white rounded"
                  style={{ borderRadius: "4px" }}
                >
                  保存
                </button>
                {item.isPlaceholder && (
                  <span className="text-xs text-adm-caution px-2 py-0.5 border border-adm-caution rounded">
                    要差替
                  </span>
                )}
              </div>
            </form>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/app/(admin)/admin/media/page.tsx
git commit -m "feat: /admin/media library UI with alt editor (spec 3-7)"
```

---

## Task 14: Preview page — demonstrate CMS end-to-end

**Files:**
- Create: `src/app/(admin)/admin/preview/home/page.tsx`

- [ ] **Step 1: Create the preview page**

This page reads `published_fields` and `published_blocks` from the `home` page in the DB (falling back to draft if not yet published) and renders the hero headline and image reference. Values come from CMS — no hardcoded Japanese.

```tsx
import { getPage } from "@/lib/cms/pages-actions";
import { getAllSiteSettings } from "@/lib/cms/site-settings-actions";
import { getAllTerminology } from "@/lib/cms/terminology-actions";
import type { Block } from "@/domain/cms/blocks";

export const metadata = { title: "プレビュー: トップ" };

/** ブロックレンダラー（プレビュー用最小実装 / フェーズ5で公開側に移管） */
function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case "hero":
      return (
        <section className="py-16 px-6 text-center bg-pub-surface border border-pub-border rounded-lg">
          {block.imageId && (
            <p className="text-xs text-pub-sub mb-4">
              [画像 ID: {block.imageId}]（本番は next/image で配信）
            </p>
          )}
          <h1 className="text-2xl font-bold text-pub-text mb-3">{block.heading}</h1>
          {block.subheading && (
            <p className="text-base text-pub-sub mb-6">{block.subheading}</p>
          )}
          {block.ctaLabel && block.ctaHref && (
            <a
              href={block.ctaHref}
              className="inline-block px-6 py-3 bg-pub-primary text-pub-bg font-semibold rounded"
              style={{ borderRadius: "4px" }}
            >
              {block.ctaLabel}
            </a>
          )}
        </section>
      );
    case "cta":
      return (
        <section className="py-8 text-center">
          <a
            href={block.href}
            className="inline-block px-6 py-3 bg-pub-primary text-pub-bg font-semibold rounded"
            style={{ borderRadius: "4px" }}
          >
            {block.label}
          </a>
          {block.subtext && (
            <p className="text-sm text-pub-sub mt-2">{block.subtext}</p>
          )}
        </section>
      );
    case "text":
      return (
        <section className="py-6 px-6">
          <p className="text-pub-text">{block.body}</p>
        </section>
      );
    default:
      return (
        <section className="py-4 px-6 border border-dashed border-pub-border rounded">
          <p className="text-xs text-pub-sub">ブロック: {block.type}</p>
        </section>
      );
  }
}

export default async function PreviewHomePage() {
  const [page, settings, terms] = await Promise.all([
    getPage("home"),
    getAllSiteSettings(),
    getAllTerminology(),
  ]);

  // 公開済みがあれば公開、なければ下書きを使用
  const fields = (page?.publishedFields ?? page?.draftFields ?? {}) as {
    heading?: string;
    lead?: string;
    heroImageId?: string | null;
  };
  const blocks: Block[] = page?.publishedBlocks ?? page?.draftBlocks ?? [];
  const isUsingDraft = !page?.publishedBlocks;

  const brandName = String(settings["brand_name"] ?? "（屋号未設定）");
  const staffNoun = String(terms["staff_noun"] ?? "セラピスト");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-adm-text">
          プレビュー: トップページ
        </h1>
        <div className="flex items-center gap-3">
          {isUsingDraft && (
            <span className="text-xs text-adm-caution border border-adm-caution px-2 py-0.5 rounded">
              下書きを表示中（未公開）
            </span>
          )}
          <a
            href="/admin/pages/home"
            className="text-sm text-adm-primary hover:underline"
          >
            編集する →
          </a>
        </div>
      </div>

      {/* デバッグ情報（開発時のみ） */}
      <div className="mb-6 px-4 py-3 bg-adm-bg border border-adm-border rounded text-xs space-y-1">
        <p><strong>屋号（CMS）:</strong> {brandName}</p>
        <p><strong>staff_noun（用語辞書）:</strong> {staffNoun}</p>
        <p><strong>ページフィールド heading:</strong> {fields.heading ?? "（未設定）"}</p>
        <p><strong>ブロック数:</strong> {blocks.length}</p>
      </div>

      {/* 公開側プレビュー（ダーク背景） */}
      <div className="bg-pub-bg min-h-[400px] p-6 rounded-lg space-y-4">
        {blocks.length === 0 ? (
          <p className="text-pub-sub text-sm text-center py-20">
            ブロックがありません。
            <a href="/admin/pages/home" className="text-pub-primary ml-1 underline">
              ページ編集
            </a>
            でブロックを追加してください。
          </p>
        ) : (
          blocks
            .filter((b) => b.visible)
            .map((block) => <BlockRenderer key={block.id} block={block} />)
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add preview nav item to layout**

In `src/app/(admin)/layout.tsx`, add one more item:

```typescript
  { href: "/admin/preview/home", label: "プレビュー" },
```

- [ ] **Step 3: Verify public-side CSS tokens exist**

Check that `tailwind.config.ts` has `pub-*` colors matching spec 12-1. If they use a different naming like `bg-dark` etc., adjust the class names in the preview page accordingly. If the tokens don't exist yet, add them to `tailwind.config.ts`:

```typescript
// In the extend.colors section:
"pub-bg": "#151A20",
"pub-surface": "#1E252D",
"pub-text": "#EDE9E2",
"pub-sub": "#9BA5AF",
"pub-primary": "#C6A15B",
"pub-border": "#2C343D",
```

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/app/(admin)/admin/preview/ src/app/(admin)/layout.tsx
git commit -m "feat: /admin/preview/home - end-to-end CMS preview (spec phase 3 completion)"
```

---

## Task 15: RLS integration tests for new tables

**Files:**
- Modify: `tests/integration/auth-rls.test.ts`

- [ ] **Step 1: Add new test cases at the end of the file**

Add this describe block after the existing `entity_records` describe block:

```typescript
describe("pages の RLS（spec 3-6 / 15章）", () => {
  const testSlug = "rls-probe-page";

  beforeAll(async () => {
    await sql`
      insert into pages (slug, locale, draft_fields, draft_blocks)
      values (${testSlug}, 'ja', '{"heading":"probe"}'::jsonb, '[]'::jsonb)
      on conflict (slug, locale) do update set draft_fields = excluded.draft_fields
    `;
  });

  afterAll(async () => {
    await sql`delete from pages where slug = ${testSlug}`;
  });

  it("therapist は pages を select できない（0件）", async () => {
    const rows = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`select id from pages where slug = ${testSlug}`;
    });
    expect(rows.length).toBe(0);
  });

  it("owner は pages を select・update できる", async () => {
    await withUser(sql, sessionOf("owner"), async (tx) => {
      const rows = await tx<{ id: string }[]>`
        select id from pages where slug = ${testSlug}
      `;
      expect(rows.length).toBe(1);
      await tx`
        update pages set draft_fields = '{"heading":"owner-update"}'::jsonb
        where slug = ${testSlug}
      `;
    });
  });
});

describe("media の RLS（spec 3-7 / 15章）", () => {
  let testMediaId: string;

  beforeAll(async () => {
    const rows = await sql<{ id: string }[]>`
      insert into media (alt, tags) values ('RLS probe', '{}')
      returning id
    `;
    testMediaId = rows[0]!.id;
  });

  afterAll(async () => {
    await sql`delete from media where id = ${testMediaId}::uuid`;
  });

  it("therapist は media を select できる（公開ページが参照する）", async () => {
    const rows = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`select id from media where id = ${testMediaId}::uuid`;
    });
    expect(rows.length).toBe(1);
  });

  it("therapist は media を update できない（RLS 拒否）", async () => {
    const updated = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`
        update media set alt = 'hacked' where id = ${testMediaId}::uuid returning id
      `;
    });
    // UPDATE は using ポリシーが therapist に無いので 0 行更新
    expect(updated.length).toBe(0);
  });

  it("admin は media を update できる", async () => {
    await withUser(sql, sessionOf("admin"), async (tx) => {
      await tx`update media set alt = 'admin-update' where id = ${testMediaId}::uuid`;
    });
    const check = await sql<{ alt: string }[]>`
      select alt from media where id = ${testMediaId}::uuid
    `;
    expect(check[0]?.alt).toBe("admin-update");
  });
});
```

- [ ] **Step 2: Run integration tests**

```bash
pnpm test tests/integration/auth-rls.test.ts
```
Expected: all tests PASS (including the new RLS network coverage test which will now include `pages`, `media`, `banned_words`)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/auth-rls.test.ts
git commit -m "test: add pages + media RLS integration tests (spec 15章)"
```

---

## Task 16: Final validation

- [ ] **Step 1: Run full test suite**

```bash
pnpm db:reset && pnpm test
```
Expected: all tests pass

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: no errors, no `any` warnings

- [ ] **Step 3: Run build**

```bash
pnpm build
```
Expected: build succeeds

- [ ] **Step 4: Verify end-to-end flow manually**

1. Start dev server: `pnpm dev`
2. Open `http://localhost:3000/admin/pages/home`
3. Change the Hero ブロック見出し to any text, click 保存
4. Click 公開する
5. Open `http://localhost:3000/admin/preview/home`
6. Confirm the new heading appears in the preview

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -p
git commit -m "fix: final adjustments from validation"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] 優先度0 — dev-session gated behind `ADMIN_DEV_SESSION` (Task 1)
- [x] spec 3-6 サイト設定 — saveSiteSetting + UI at /admin/settings (Tasks 7, 11)
- [x] spec 13-1 用語辞書 — saveTerminology + UI at /admin/settings (Tasks 7, 11)
- [x] spec 3-6 固定ページ + ブロック — pages table, blocksArraySchema, savePageFields, savePageBlocks, publishPage, UI at /admin/pages (Tasks 2, 4, 8, 12)
- [x] spec 3-6 ブロックホワイトリスト — 10種のみ、Zod discriminated union (Task 4)
- [x] spec 3-7 メディアライブラリ — media table, upsertMediaMeta, listMedia, UI at /admin/media (Tasks 2, 3, 9, 13)
- [x] spec 3-7 alt 必須 — schema NOT NULL + Zod min(1) (Tasks 2, 9)
- [x] spec 3-7 ストレージ抽象化 — MediaStorage interface + Supabase skeleton + local stub (Task 6)
- [x] spec 13-2 禁止語チェック — checkBannedWords pure function, called in publishPage (Tasks 5, 8)
- [x] 完了条件実証 — /admin/preview/home renders from CMS (Task 14)
- [x] シード拡張 — pages, media, banned_words seeded idempotently (Task 10)
- [x] RLS 網羅テスト — pages + media added to auth-rls.test.ts (Task 15)
- [x] 14章フェーズ3完了条件 — CMS からトップ見出し・画像を差し替えてプレビューに反映

**Gaps checked:**
- spec 3-7 WebP 変換・複数サイズ: sharp は追加しない（TODO in storage.ts — 依存最小限）
- spec 3-6 お知らせ/notices テーブル: フェーズ3スコープ外（14章にnotices未記載）
- spec 3-6 公開予約（指定日時公開）: フェーズ3スコープ外（基本draft/publishで対応）
- spec 14章完了条件「トップの見出しと画像をCMSから差し替えられる」: /admin/pages/home + /admin/preview/home で実証
