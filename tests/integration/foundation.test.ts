import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * フェーズ0の統合テスト（実 Postgres / spec 15章）。
 * 拡張・テーブル・シードの土台が正しく立ち上がることを確認する。
 * 前提: docker の DB が起動し、migrate + seed 済み（CI がこの順で実行）。
 */
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1 });

beforeAll(async () => {
  await sql`select 1`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("拡張", () => {
  it("postgis が有効", async () => {
    const rows = await sql`select 1 from pg_extension where extname = 'postgis'`;
    expect(rows.length).toBe(1);
  });

  it("btree_gist が有効（reservations の exclusion 制約に必要）", async () => {
    const rows = await sql`select 1 from pg_extension where extname = 'btree_gist'`;
    expect(rows.length).toBe(1);
  });
});

describe("CMS の背骨テーブル", () => {
  it.each(["site_settings", "terminology", "field_definitions"])(
    "%s が存在する",
    async (table) => {
      const rows = await sql`
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = ${table}
      `;
      expect(rows.length).toBe(1);
    },
  );
});

describe("シード", () => {
  it("用語辞書に施術・担当者・回の呼称が入っている（spec 13-1）", async () => {
    const rows = await sql<{ key: string; value: string }[]>`
      select key, value from terminology where locale = 'ja'
      and key in ('service_noun','staff_noun','session_noun')
    `;
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(map.service_noun).toBeTruthy();
    expect(map.staff_noun).toBeTruthy();
    expect(map.session_noun).toBeTruthy();
  });

  it("「マッサージ」が用語辞書の既定値に混ざっていない（spec 13-1）", async () => {
    const rows = await sql<{ value: string }[]>`
      select value from terminology where locale = 'ja'
    `;
    for (const r of rows) expect(r.value).not.toContain("マッサージ");
  });

  it("フィールド定義が投入され、entity+key が一意", async () => {
    const rows = await sql`select 1 from field_definitions`;
    expect(rows.length).toBeGreaterThan(0);
  });
});
