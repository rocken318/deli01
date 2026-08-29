# jsonb 二重エンコードバグ修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** postgres.js の `${JSON.stringify(x)}::jsonb` パターン（二重エンコードで jsonb_typeof=string になるバグ）を全ファイルで `${sql.json(x)}` / `${tx.json(x)}` に置き換え、回帰テストを追加し、`/admin/preview/home` が 500 にならないことを保証する。

**Architecture:** postgres.js 3.x では `sql.json(x)` / `tx.json(x)` を使うと postgres.js がパラメータを正しく jsonb として送信する。`${JSON.stringify(x)}::jsonb` はまず JS が文字列にシリアライズしてから Postgres がテキストキャストするため、jsonb の文字列型として格納される（二重エンコード）。修正は純粋な置き換えのみで、ロジック変更はない。`getPage` の `blocksArraySchema.parse` は壊れた既存データで 500 になる可能性があるため `safeParse` + 空配列フォールバックに変更する。

**Tech Stack:** postgres.js 3.4.9, Next.js 15, Vitest 2, TypeScript 5.7

---

## 影響ファイル一覧

### 修正対象（計23箇所）

| ファイル | 修正箇所 |
|---|---|
| `src/lib/cms/actions.ts` | 行 131, 152, 227, 245, 246, 306, 359, 421, 439（9箇所） |
| `src/lib/cms/pages-actions.ts` | 行 40, 48, 72, 77（4箇所） |
| `src/lib/cms/site-settings-actions.ts` | 行 32, 38, 39（3箇所） |
| `src/lib/cms/media-actions.ts` | 行 55, 70（2箇所） |
| `src/lib/cms/terminology-actions.ts` | 行 36（1箇所） |
| `scripts/seed.ts` | 行 202, 213, 234, 242（4箇所） |

### 新規作成

- `tests/integration/jsonb-encoding.test.ts` — jsonb_typeof 回帰テスト

### `getPage` の safeParse 化

- `src/lib/cms/pages-actions.ts`（行 154–155）— `blocksArraySchema.parse` → `safeParse` + 空配列フォールバック

---

## Task 1: `src/lib/cms/actions.ts` の修正

**Files:**
- Modify: `src/lib/cms/actions.ts`

### 変更ルール

`withUser(sql, session, async (tx) => { ... })` ブロック内では **`tx.json(x)`** を使う。
`null` になりうる条件式 `cond ? JSON.stringify(x) : null` は `cond ? tx.json(x) : null` にする（null は SQL NULL として渡る）。

- [ ] **Step 1: 行 131 — options の insert（null 条件付き）**

変更前（実際のファイルの内容）:
```
${data.options != null ? JSON.stringify(data.options) : null}::jsonb,
```
変更後:
```
${data.options != null ? tx.json(data.options) : null},
```

- [ ] **Step 2: 行 152 — addFieldDefinition の audit_logs after**

変更前:
```
${JSON.stringify({ entity: data.entity, key: data.key, label: data.label })}::jsonb
```
変更後:
```
${tx.json({ entity: data.entity, key: data.key, label: data.label })}
```

- [ ] **Step 3: 行 227 — updateFieldDefinition の options coalesce**

変更前:
```
options     = coalesce(${data.options != null ? JSON.stringify(data.options) : null}::jsonb, options),
```
変更後:
```
options     = coalesce(${data.options != null ? tx.json(data.options) : null}, options),
```

- [ ] **Step 4: 行 245–246 — updateFieldDefinition の audit_logs before/after**

変更前（2行）:
```
${JSON.stringify(before)}::jsonb,
${JSON.stringify(data)}::jsonb
```
変更後:
```
${tx.json(before)},
${tx.json(data)}
```

- [ ] **Step 5: 行 306 — toggleFieldVisibility の audit_logs after**

変更前:
```
${JSON.stringify({ hide })}::jsonb
```
変更後:
```
${tx.json({ hide })}
```

- [ ] **Step 6: 行 359 — reorderFieldDefinitions の audit_logs after**

変更前:
```
${JSON.stringify(parsed.data)}::jsonb
```
変更後:
```
${tx.json(parsed.data)}
```

- [ ] **Step 7: 行 421 — saveEntityRecord の draft upsert**

変更前:
```
${JSON.stringify(validatedDraft)}::jsonb
```
変更後:
```
${tx.json(validatedDraft)}
```

- [ ] **Step 8: 行 439 — saveEntityRecord の audit_logs after**

変更前:
```
${JSON.stringify({ entity: parsed.data.entity, slug: parsed.data.slug })}::jsonb
```
変更後:
```
${tx.json({ entity: parsed.data.entity, slug: parsed.data.slug })}
```

- [ ] **Step 9: grep で確認**

```bash
grep -n 'JSON.stringify.*::jsonb' src/lib/cms/actions.ts
```

期待結果: 出力なし（0件）

---

## Task 2: `src/lib/cms/pages-actions.ts` の修正

**Files:**
- Modify: `src/lib/cms/pages-actions.ts`

- [ ] **Step 1: 行 40 — savePageFields の draft_fields insert**

変更前:
```
values (${slug}, ${locale}, ${JSON.stringify(parsedFields.data)}::jsonb)
```
変更後:
```
values (${slug}, ${locale}, ${tx.json(parsedFields.data)})
```

- [ ] **Step 2: 行 48 — savePageFields の audit_logs after**

変更前:
```
values (${session.userId}::uuid, 'update', 'page', ${row.id}::uuid, ${JSON.stringify({ slug, locale })}::jsonb)
```
変更後:
```
values (${session.userId}::uuid, 'update', 'page', ${row.id}::uuid, ${tx.json({ slug, locale })})
```

- [ ] **Step 3: 行 72 — savePageBlocks の draft_blocks insert**

変更前:
```
values (${slug}, ${locale}, ${JSON.stringify(parsedBlocks.data)}::jsonb)
```
変更後:
```
values (${slug}, ${locale}, ${tx.json(parsedBlocks.data)})
```

- [ ] **Step 4: 行 77 — savePageBlocks の audit_logs after**

変更前:
```
values (${session.userId}::uuid, 'update', 'page_blocks', ${JSON.stringify({ slug, locale, count: parsedBlocks.data.length })}::jsonb)
```
変更後:
```
values (${session.userId}::uuid, 'update', 'page_blocks', ${tx.json({ slug, locale, count: parsedBlocks.data.length })})
```

- [ ] **Step 5: 行 154–155 — getPage の blocksArraySchema.parse を safeParse に変更（壊れた既存データへの安全策）**

変更前（pages-actions.ts の getPage 内）:
```typescript
  const draftBlocks = blocksArraySchema.parse(row.draft_blocks ?? []);
  const publishedBlocks = row.published_blocks ? blocksArraySchema.parse(row.published_blocks) : null;
```
変更後:
```typescript
  const draftBlocksParsed = blocksArraySchema.safeParse(row.draft_blocks ?? []);
  const draftBlocks = draftBlocksParsed.success ? draftBlocksParsed.data : [];
  const publishedBlocksParsed = row.published_blocks
    ? blocksArraySchema.safeParse(row.published_blocks)
    : null;
  const publishedBlocks = publishedBlocksParsed?.success ? publishedBlocksParsed.data : null;
```

- [ ] **Step 6: grep で確認**

```bash
grep -n 'JSON.stringify.*::jsonb' src/lib/cms/pages-actions.ts
```

期待結果: 出力なし（0件）

---

## Task 3: `src/lib/cms/site-settings-actions.ts` の修正

**Files:**
- Modify: `src/lib/cms/site-settings-actions.ts`

- [ ] **Step 1: 行 32 — saveSiteSetting の value insert**

変更前:
```
values (${parsed.data.key}, ${JSON.stringify(parsed.data.value)}::jsonb)
```
変更後:
```
values (${parsed.data.key}, ${tx.json(parsed.data.value)})
```

- [ ] **Step 2: 行 38–39 — saveSiteSetting の audit_logs before/after**

変更前（2行）:
```
          ${JSON.stringify({ key: parsed.data.key, value: before })}::jsonb,
          ${JSON.stringify({ key: parsed.data.key, value: parsed.data.value })}::jsonb)
```
変更後:
```
          ${tx.json({ key: parsed.data.key, value: before })},
          ${tx.json({ key: parsed.data.key, value: parsed.data.value })})
```

- [ ] **Step 3: grep で確認**

```bash
grep -n 'JSON.stringify.*::jsonb' src/lib/cms/site-settings-actions.ts
```

期待結果: 出力なし（0件）

---

## Task 4: `src/lib/cms/media-actions.ts` の修正

**Files:**
- Modify: `src/lib/cms/media-actions.ts`

- [ ] **Step 1: 行 55 — update 後の audit_logs after**

変更前:
```
values (${session.userId}::uuid, 'update', 'media', ${data.id}::uuid, ${JSON.stringify({ alt: data.alt, tags: data.tags })}::jsonb)
```
変更後:
```
values (${session.userId}::uuid, 'update', 'media', ${data.id}::uuid, ${tx.json({ alt: data.alt, tags: data.tags })})
```

- [ ] **Step 2: 行 70 — insert 後の audit_logs after**

変更前:
```
values (${session.userId}::uuid, 'create', 'media', ${row.id}::uuid, ${JSON.stringify({ alt: data.alt, tags: data.tags })}::jsonb)
```
変更後:
```
values (${session.userId}::uuid, 'create', 'media', ${row.id}::uuid, ${tx.json({ alt: data.alt, tags: data.tags })})
```

- [ ] **Step 3: grep で確認**

```bash
grep -n 'JSON.stringify.*::jsonb' src/lib/cms/media-actions.ts
```

期待結果: 出力なし（0件）

---

## Task 5: `src/lib/cms/terminology-actions.ts` の修正

**Files:**
- Modify: `src/lib/cms/terminology-actions.ts`

- [ ] **Step 1: 行 36 — saveTerminology の audit_logs after**

変更前:
```
values (${session.userId}::uuid, 'update', 'terminology', ${JSON.stringify(parsed.data)}::jsonb)
```
変更後:
```
values (${session.userId}::uuid, 'update', 'terminology', ${tx.json(parsed.data)})
```

- [ ] **Step 2: grep で確認**

```bash
grep -n 'JSON.stringify.*::jsonb' src/lib/cms/terminology-actions.ts
```

期待結果: 出力なし（0件）

---

## Task 6: `scripts/seed.ts` の修正

**Files:**
- Modify: `scripts/seed.ts`

seed.ts はトランザクション内ではなく、直接 `sql` タグを使う。そのため `sql.json(x)` を使う（`tx` は存在しない）。

- [ ] **Step 1: 行 202 — site_settings の value insert**

変更前:
```
        values (${s.key}, ${JSON.stringify(s.value)}::jsonb)
```
変更後:
```
        values (${s.key}, ${sql.json(s.value)})
```

- [ ] **Step 2: 行 213 — field_definitions の options insert（条件付き null）**

変更前:
```
          ${"options" in f ? JSON.stringify(f.options) : null}::jsonb,
```
変更後:
```
          ${"options" in f ? sql.json(f.options) : null},
```

- [ ] **Step 3: 行 234 — entity_records の draft insert**

変更前:
```
        values (${r.entity}, ${r.slug}, ${JSON.stringify(r.draft)}::jsonb)
```
変更後:
```
        values (${r.entity}, ${r.slug}, ${sql.json(r.draft)})
```

- [ ] **Step 4: 行 242 — pages の draft_fields / draft_blocks insert（同一行に2箇所）**

変更前:
```
        values (${p.slug}, ${p.locale}, ${JSON.stringify(p.draft_fields)}::jsonb, ${JSON.stringify(p.draft_blocks)}::jsonb)
```
変更後:
```
        values (${p.slug}, ${p.locale}, ${sql.json(p.draft_fields)}, ${sql.json(p.draft_blocks)})
```

- [ ] **Step 5: grep で確認**

```bash
grep -n 'JSON.stringify.*::jsonb' scripts/seed.ts
```

期待結果: 出力なし（0件）

---

## Task 7: 全体 grep 確認

- [ ] **Step 1: プロジェクト全体で JSON.stringify.*::jsonb が 0 件であること**

```bash
grep -rn 'JSON.stringify' src scripts --include='*.ts' | grep '::jsonb'
```

期待結果: 出力なし（0件）

---

## Task 8: 回帰テスト `tests/integration/jsonb-encoding.test.ts` の追加

**Files:**
- Create: `tests/integration/jsonb-encoding.test.ts`

目的: `pnpm db:reset` 後に seed が書き込んだ jsonb カラムの型が正しいことを実 Postgres で検証する。

- [ ] **Step 1: テストファイルを作成する**

以下の内容でファイルを作成する（`tests/integration/jsonb-encoding.test.ts`）:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * jsonb 二重エンコードバグ回帰テスト（spec: postgres.js 3.x の sql.json ヘルパ使用確認）。
 *
 * 前提: docker の DB が起動し、migrate + seed 済み（pnpm db:reset 後に実行）。
 * 検証: seed が書き込んだ jsonb カラムが jsonb_typeof で正しい型（object/array）になっていること。
 * バグ状態: ${JSON.stringify(x)}::jsonb → jsonb_typeof = 'string'（誤り）
 * 正常状態: ${sql.json(x)} → jsonb_typeof = 'object' または 'array'（正しい）
 */

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

beforeAll(async () => {
  await sql`select 1`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("jsonb 型エンコード検証（二重エンコードバグ回帰）", () => {
  it("field_definitions.options は jsonb_typeof = 'object'（options が null でない行）", async () => {
    const rows = await sql<{ t: string }[]>`
      select jsonb_typeof(options) as t
      from field_definitions
      where options is not null
      limit 1
    `;
    // options を持つ行が少なくとも1件ある（good_at フィールドが choices を持つ）
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.t).toBe("object");
  });

  it("entity_records.draft は jsonb_typeof = 'object'", async () => {
    const rows = await sql<{ t: string }[]>`
      select jsonb_typeof(draft) as t
      from entity_records
      where draft is not null
      limit 1
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.t).toBe("object");
  });

  it("pages.draft_blocks は jsonb_typeof = 'array'", async () => {
    const rows = await sql<{ t: string }[]>`
      select jsonb_typeof(draft_blocks) as t
      from pages
      where draft_blocks is not null
      limit 1
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.t).toBe("array");
  });

  it("pages.draft_fields は jsonb_typeof = 'object'", async () => {
    const rows = await sql<{ t: string }[]>`
      select jsonb_typeof(draft_fields) as t
      from pages
      where draft_fields is not null
      limit 1
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.t).toBe("object");
  });

  it("site_settings.value（brand_name）は余分な二重引用符がない（二重エンコードされていない）", async () => {
    // 正常: value を postgres が返すと JS string '（屋号未設定）' になる
    // バグ: value が '"（屋号未設定）"'（JSON エンコードされた文字列）になる
    const rows = await sql<{ value: string }[]>`
      select value from site_settings where key = 'brand_name'
    `;
    expect(rows.length).toBe(1);
    const v = rows[0]!.value as unknown;
    // postgres.js は jsonb を JS 値としてデシリアライズして返す
    // 正常: v は string で、先頭・末尾に余分な " がない
    expect(typeof v).toBe("string");
    expect((v as string).startsWith('"')).toBe(false);
    expect((v as string).endsWith('"')).toBe(false);
  });

  it("site_settings.value は jsonb_typeof = 'string'（スカラ文字列はこれが正しい）", async () => {
    // brand_name などの文字列値はスカラなので jsonb_typeof = 'string' が正しい
    // 二重エンコードでも 'string' になるため、この確認だけでは不十分（上のテストと組み合わせる）
    const rows = await sql<{ t: string }[]>`
      select jsonb_typeof(value) as t from site_settings where key = 'brand_name'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.t).toBe("string");
  });
});
```

- [ ] **Step 2: テストが DB 接続を必要とすることを確認し、事前に db:reset を実行**

```bash
pnpm db:reset
```

期待結果: `シード完了: ...` のメッセージが出て正常終了

- [ ] **Step 3: テストを単体実行して全パスを確認**

```bash
pnpm test tests/integration/jsonb-encoding.test.ts
```

期待結果: 5件のテストが全て PASS

---

## Task 9: typecheck / lint / test / build の確認

- [ ] **Step 1: TypeScript 型チェック**

```bash
pnpm typecheck
```

期待結果: エラー 0 件

- [ ] **Step 2: lint**

```bash
pnpm lint
```

期待結果: エラー 0 件

- [ ] **Step 3: 全テスト実行（db:reset 後）**

```bash
pnpm test
```

期待結果: 全テスト PASS（jsonb-encoding.test.ts の 5 件を含む）

- [ ] **Step 4: ビルド確認**

```bash
pnpm build
```

期待結果: エラーなくビルド完了

---

## Task 10: preview エンドポイントの動作確認

- [ ] **Step 1: dev サーバーをバックグラウンドで起動**

Windows PowerShell の場合:
```powershell
Start-Process -NoNewWindow -FilePath "pnpm" -ArgumentList "dev" -RedirectStandardOutput "dev.log"
```

または Bash の場合:
```bash
pnpm dev > dev.log 2>&1 &
```

その後 10 秒待つ（`sleep 10` または手動で `dev.log` を確認）。

- [ ] **Step 2: HTTP ステータスコードが 200 であることを確認**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/admin/preview/home
```

期待結果: `200`

- [ ] **Step 3: dev プロセスを終了**

```bash
# Windows: PowerShell でポート 3000 を使っているプロセスを確認して終了
netstat -ano | findstr :3000
# PID を確認して: taskkill /PID <PID> /F
```

---

## Self-Review

### Spec カバレッジ

1. `JSON.stringify.*::jsonb` → `sql.json` / `tx.json` の置き換え: 全6ファイル23箇所 — カバー済み
2. `publishPage` 内の `allText = JSON.stringify(page.draft_fields) + ...` — jsonb パラメータでないため除外（正しい）
3. `getPage` の `blocksArraySchema.parse` → `safeParse` フォールバック — Task 2 Step 5 でカバー
4. 回帰テスト（jsonb_typeof 検証）— Task 8 でカバー
5. grep 0件確認 — Task 7 でカバー
6. typecheck/lint/test/build — Task 9 でカバー
7. preview 200 確認 — Task 10 でカバー

### プレースホルダースキャン

全ステップに実際のコードを記載済み。"TBD" や "similar to" の記述なし。

### 型の一貫性

`tx.json(x)` はトランザクション内（`withUser` コールバック引数）のみ使用。
`sql.json(x)` は seed.ts（トランザクション外）のみ使用。
混用なし。
