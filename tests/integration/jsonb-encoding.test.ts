import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * jsonb 二重エンコードバグ回帰テスト。
 *
 * postgres.js 3.x で `${JSON.stringify(x)}::jsonb` を使うと二重エンコードになり、
 * jsonb_typeof が object/array ではなく 'string' になってしまう（バグ）。
 * 正しくは `${sql.json(x)}`（`::jsonb` キャストなし）を使う。
 *
 * 前提: docker の DB が起動し、migrate + seed 済み（pnpm db:reset 後に実行）。
 * seed が書き込んだ jsonb カラムの型が正しいことを実 Postgres で検証する。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

beforeAll(async () => {
  await sql`select 1`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("jsonb 型エンコード検証（二重エンコードバグ回帰）", () => {
  it("field_definitions.options は jsonb_typeof = 'object'（non-null 行）", async () => {
    const rows = await sql<{ t: string }[]>`
      select jsonb_typeof(options) as t
      from field_definitions
      where options is not null
      limit 1
    `;
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

  it("site_settings.value（brand_name）は string で余分な二重引用符がない（二重エンコードされていない）", async () => {
    // 正常: postgres.js が jsonb をデシリアライズし JS string '（屋号未設定）' を返す。
    // バグ: '"（屋号未設定）"' のように先頭・末尾に余分な " が付く。
    const rows = await sql<{ value: unknown }[]>`
      select value from site_settings where key = 'brand_name'
    `;
    expect(rows.length).toBe(1);
    const v = rows[0]!.value;
    expect(typeof v).toBe("string");
    const s = v as string;
    expect(s.startsWith('"')).toBe(false);
    expect(s.endsWith('"')).toBe(false);
    // seed 値をそのまま（JSON.parse せず）使えること
    expect(s).toBe("（屋号未設定）");
  });
});
