import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  listEntityRecords,
  createEntityRecordByName,
} from "@/lib/cms/actions";

/**
 * #2 コンテンツ直感UX の統合テスト（実 Postgres）。
 * 名前だけで entity_records を作成でき、一覧に出ることを確認する。
 * 前提: ADMIN_DEV_SESSION=1（vitest.config が .env を読む）＝ getDevSession が seed owner。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const enabled = process.env.ADMIN_DEV_SESSION === "1";

afterAll(async () => {
  await sql`delete from entity_records where slug like 'phase2-qa-%' or draft->>'name' = 'QAクイック追加'`;
  await sql.end({ timeout: 5 });
});

describe.skipIf(!enabled)("コンテンツ 一覧＋名前だけ追加（#2）", () => {
  beforeAll(async () => {
    // 既存 seed のセラピストは entity_records にある（一覧の前提）
    const n = await sql<{ c: number }[]>`
      select count(*)::int as c from entity_records where entity = 'therapist'
    `;
    expect(n[0]!.c).toBeGreaterThanOrEqual(1);
  });

  it("listEntityRecords は entity のコンテンツを name 付きで返す", async () => {
    const result = await listEntityRecords("therapist");
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    // name は draft.name（無ければ slug フォールバック）で必ず埋まる
    expect(result.data!.every((r) => r.name.length > 0)).toBe(true);
  });

  it("名前だけで作成でき、slug が自動採番され、一覧に出る", async () => {
    const created = await createEntityRecordByName("course", "QAクイック追加");
    expect(created.ok).toBe(true);
    expect(created.data!.slug).toMatch(/^[a-z0-9-]+$/); // 日本語のみ → entity 名ベースの slug

    const list = await listEntityRecords("course");
    expect(list.ok).toBe(true);
    const found = list.data!.find((r) => r.slug === created.data!.slug);
    expect(found).toBeDefined();
    expect(found!.name).toBe("QAクイック追加");
    expect(found!.publishedAt).toBeNull(); // 作成直後は下書き
  });

  it("同名を2回作っても slug が衝突しない（-2 で一意化）", async () => {
    const a = await createEntityRecordByName("course", "QAクイック追加");
    const b = await createEntityRecordByName("course", "QAクイック追加");
    expect(a.ok && b.ok).toBe(true);
    expect(a.data!.slug).not.toBe(b.data!.slug);
  });

  it("空名は拒否する", async () => {
    const result = await createEntityRecordByName("course", "   ");
    expect(result.ok).toBe(false);
  });

  it("未知の entity は拒否する", async () => {
    const result = await createEntityRecordByName("bogus", "x");
    expect(result.ok).toBe(false);
  });
});
