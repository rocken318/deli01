import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { checkBannedWords } from "@/domain/cms/banned-words";

/**
 * フェーズ3の統合テスト（実 Postgres / spec 13-2・15章）。
 *
 * 検証の骨子:
 * - 禁止語を含む draft を公開すると warnings が返る（spec 13-2: 警告のみ・ブロックしない）。
 *   publishPage の warnings 生成ロジックと同じ経路（banned_words シード読取 + checkBannedWords）
 *   を実 Postgres のシードデータに対して実行し、警告が立つことを確認する。
 * - media.alt の空文字は DB 制約（media_alt_not_blank）で拒否される（spec 3-7 / 15）。
 *
 * 前提: docker の DB が起動し、migrate + seed 済み（pnpm db:reset 後に実行）。
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

describe("禁止語警告（spec 13-2: 公開はブロックしない・警告のみ）", () => {
  const slug = "banned-word-probe";

  beforeAll(async () => {
    // draft に禁止語（seed の "治療"）を含むページを用意
    await sql`
      insert into pages (slug, locale, draft_fields, draft_blocks)
      values (
        ${slug}, 'ja',
        ${sql.json({ heading: "この施術で必ず治療します", lead: "" })},
        ${sql.json([
          {
            id: "probe-hero",
            type: "hero",
            visible: true,
            heading: "国家資格を持つスタッフが対応",
            subheading: "",
            imageId: null,
            ctaLabel: "",
            ctaHref: "",
          },
        ])}
      )
      on conflict (slug, locale) do update
        set draft_fields = excluded.draft_fields, draft_blocks = excluded.draft_blocks
    `;
  });

  afterAll(async () => {
    await sql`delete from pages where slug = ${slug}`;
  });

  it("banned_words シードが投入されている（'治療'・'国家資格' を含む）", async () => {
    const rows = await sql<{ word: string }[]>`select word from banned_words`;
    const words = rows.map((r) => r.word);
    expect(words).toContain("治療");
    expect(words).toContain("国家資格");
  });

  it("禁止語を含む draft の公開では warnings が返る（publishPage と同じ経路）", async () => {
    const pageRows = await sql<{ draft_fields: unknown; draft_blocks: unknown }[]>`
      select draft_fields, draft_blocks from pages where slug = ${slug} and locale = 'ja'
    `;
    expect(pageRows.length).toBe(1);
    const page = pageRows[0]!;

    const wordRows = await sql<{ word: string }[]>`select word from banned_words`;
    const wordList = wordRows.map((r) => r.word);

    // publishPage が組み立てるのと同じ全文（fields + blocks の JSON）
    const allText =
      JSON.stringify(page.draft_fields) + " " + JSON.stringify(page.draft_blocks);
    const warnings = checkBannedWords(allText, wordList).map(
      (w) => `禁止語「${w}」が含まれています`,
    );

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings).toContain("禁止語「治療」が含まれています");
    expect(warnings).toContain("禁止語「国家資格」が含まれています");
  });

  it("禁止語を含まない draft では warnings が空", async () => {
    const wordRows = await sql<{ word: string }[]>`select word from banned_words`;
    const wordList = wordRows.map((r) => r.word);
    const clean = JSON.stringify({ heading: "心地よいひとときを", lead: "リラックスできます" });
    const warnings = checkBannedWords(clean, wordList);
    expect(warnings).toEqual([]);
  });
});

describe("media.alt の空文字拒否（spec 3-7 / 15: DB 制約 + Zod の二重化）", () => {
  it("alt = '' の insert は check 制約で拒否される", async () => {
    await expect(
      sql`insert into media (alt, tags) values ('', '{}')`,
    ).rejects.toThrow(/media_alt_not_blank|violates check constraint/);
  });

  it("alt が非空なら insert できる（後片付けあり）", async () => {
    const rows = await sql<{ id: string }[]>`
      insert into media (alt, tags) values ('空でない alt', '{}') returning id
    `;
    expect(rows.length).toBe(1);
    await sql`delete from media where id = ${rows[0]!.id}::uuid`;
  });
});
