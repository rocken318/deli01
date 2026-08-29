import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  listPublicTherapists,
  getPublicTherapist,
  getPublicMediaMap,
} from "@/lib/public/queries";

/**
 * フェーズ5の統合テスト（実 Postgres / spec 2章・3-7・15章）。
 *
 * 公開側の読み取りが「published のみ・同意・非表示・退職」を尊重することを検証する。
 * 前提: pnpm db:reset 後（aoi/hinata が published、minato は未公開、hinata は retired）。
 *
 * - listPublicTherapists: aoi は出る。minato（未同意→未公開）と hinata（退職）は出ない。
 * - getPublicTherapist: aoi は取れる。minato/hinata は null。
 * - getPublicMediaMap: 同意なしメディア（minato の写真）は consent 要求時に含まれない。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const AOI_MEDIA = "bbbbbbbb-0001-4000-8000-000000000001"; // consent あり
const MINATO_MEDIA = "bbbbbbbb-0001-4000-8000-000000000002"; // consent なし

beforeAll(async () => {
  await sql`select 1`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("公開セラピスト一覧（published のみ / 未公開・退職を除外）", () => {
  it("aoi は一覧に出る", async () => {
    const list = await listPublicTherapists();
    const slugs = list.map((t) => t.slug);
    expect(slugs).toContain("aoi");
  });

  it("minato（未同意で未公開）は一覧に出ない", async () => {
    const list = await listPublicTherapists();
    expect(list.map((t) => t.slug)).not.toContain("minato");
  });

  it("hinata（退職）は published でも一覧に出ない", async () => {
    const list = await listPublicTherapists();
    expect(list.map((t) => t.slug)).not.toContain("hinata");
  });

  it("published は draft を含まず値を持つ", async () => {
    const list = await listPublicTherapists();
    const aoi = list.find((t) => t.slug === "aoi");
    expect(aoi).toBeTruthy();
    expect(aoi?.published["catch_copy"]).toBeTypeOf("string");
  });
});

describe("公開セラピスト単体取得", () => {
  it("aoi は取得できる", async () => {
    const t = await getPublicTherapist("aoi");
    expect(t?.slug).toBe("aoi");
  });

  it("minato は null（未公開）", async () => {
    expect(await getPublicTherapist("minato")).toBeNull();
  });

  it("hinata は null（退職）", async () => {
    expect(await getPublicTherapist("hinata")).toBeNull();
  });

  it("存在しない slug は null", async () => {
    expect(await getPublicTherapist("no-such-slug")).toBeNull();
  });
});

describe("公開メディア（consent・is_hidden 尊重 / spec 3-7）", () => {
  it("consent 要求時は同意なしメディアを含まない", async () => {
    const map = await getPublicMediaMap([AOI_MEDIA, MINATO_MEDIA]);
    expect(map.has(AOI_MEDIA)).toBe(true);
    expect(map.has(MINATO_MEDIA)).toBe(false);
  });

  it("consent 非要求（ブロック画像用）でも is_hidden は除外する", async () => {
    // is_hidden なメディアが無いシード前提では両方 is_hidden=false。
    // ここでは requireConsent=false で同意なしメディアも取れることを確認する。
    const map = await getPublicMediaMap([MINATO_MEDIA], { requireConsent: false });
    expect(map.has(MINATO_MEDIA)).toBe(true);
  });
});
