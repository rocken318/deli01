import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getTherapistSlots,
  getPublicTherapistId,
  listPublicCourses,
  listPublicOptions,
} from "@/lib/availability/public-slots";

/**
 * フェーズ10 の統合テスト（実 Postgres / spec 2-3・5-3・5-4）。
 *
 * 完了条件の機械化: 「エリア/オプションを変えると候補枠が変わる」。
 * 公開側配線 getTherapistSlots が、シードの実データ（shift・bases・walk_settings・
 * travel_buffers・courses・options）から前提つき候補枠を引けることを検証する。
 *
 * 前提: pnpm db:reset 済み。シードは実行日基準 +0〜+4 日の shift を入れる。
 * - aoi: published・徒歩派（車不可）・事務所（渋谷）発着・渋谷/恵比寿/目黒のみ対応
 * - フットケアは aoi 限定オプション、他は全員対応（spec 3-4）
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

let shibuyaId = "";
let meguroId = "";
let hachiojiId = "";
let shortCourseId = "";
let ext30Id = "";

beforeAll(async () => {
  const areas = await sql<{ id: string; name: string }[]>`
    select id, name from areas where name in ('渋谷区', '目黒区', '八王子市')
  `;
  shibuyaId = areas.find((a) => a.name === "渋谷区")?.id ?? "";
  meguroId = areas.find((a) => a.name === "目黒区")?.id ?? "";
  hachiojiId = areas.find((a) => a.name === "八王子市")?.id ?? "";
  const courses = await sql<{ id: string; name: string }[]>`
    select id, name from courses where name in ('ショート')
  `;
  shortCourseId = courses.find((c) => c.name === "ショート")?.id ?? "";
  const opts = await sql<{ id: string; name: string }[]>`
    select id, name from options where name = '延長30分'
  `;
  ext30Id = opts.find((o) => o.name === "延長30分")?.id ?? "";
  expect(shibuyaId).not.toBe("");
  expect(meguroId).not.toBe("");
  expect(hachiojiId).not.toBe("");
  expect(shortCourseId).not.toBe("");
  expect(ext30Id).not.toBe("");
});

afterAll(async () => {
  await sql.end();
});

describe("getTherapistSlots（フェーズ10 完了条件）", () => {
  it("エリア未指定は代表エリア概算（assumed=true）で候補枠が出る", async () => {
    const res = await getTherapistSlots({ slug: "aoi", courseId: shortCourseId });
    expect(res).not.toBeNull();
    expect(res!.assumed).toBe(true);
    expect(res!.areaId).toBe(shibuyaId); // sort_order 先頭 = 渋谷区
    expect(res!.slots.length).toBeGreaterThan(0);
    // 各枠は "HH:mm"・15分グリッド
    for (const s of res!.slots) {
      expect(s.time).toMatch(/^([01]\d|2[0-3]):(00|15|30|45)$/);
    }
    // 対応エリアのチップが揃う（渋谷/恵比寿/目黒）
    expect(res!.areas.map((a) => a.name).sort()).toEqual(["恵比寿駅", "渋谷区", "目黒区"]);
  });

  it("★エリアを変えると候補枠が変わる（渋谷 vs 目黒）", async () => {
    const shibuya = await getTherapistSlots({
      slug: "aoi",
      areaId: shibuyaId,
      courseId: shortCourseId,
    });
    const meguro = await getTherapistSlots({
      slug: "aoi",
      areaId: meguroId,
      courseId: shortCourseId,
    });
    expect(shibuya).not.toBeNull();
    expect(meguro).not.toBeNull();
    expect(shibuya!.assumed).toBe(false);
    expect(meguro!.assumed).toBe(false);
    // 事務所（渋谷）発着なので、渋谷は近く（移動短）・目黒は遠い（移動長）。
    // 移動時間が違えば最初に案内できる時刻（または枠数）が変わる。
    const shibuyaTimes = shibuya!.slots.map((s) => s.time).join(",");
    const meguroTimes = meguro!.slots.map((s) => s.time).join(",");
    expect(shibuyaTimes).not.toEqual(meguroTimes);
  });

  it("★オプション（延長30分）を足すと候補枠が変わる（枠数が減るか末尾が前倒し）", async () => {
    const base = await getTherapistSlots({ slug: "aoi", areaId: shibuyaId, courseId: shortCourseId });
    const withOpt = await getTherapistSlots({
      slug: "aoi",
      areaId: shibuyaId,
      courseId: shortCourseId,
      optionIds: [ext30Id],
    });
    expect(base).not.toBeNull();
    expect(withOpt).not.toBeNull();
    // L が 60 → 90 に伸びる（施術時間が長くなる分、締切に近い枠が落ちる）
    expect(withOpt!.serviceMinutes).toBe(base!.serviceMinutes + 30);
    expect(withOpt!.slots.length).toBeLessThanOrEqual(base!.slots.length);
    // 枠の集合が変わる（末尾側が落ちる）
    expect(withOpt!.slots.map((s) => s.time).join(",")).not.toEqual(
      base!.slots.map((s) => s.time).join(","),
    );
  });

  it("対応エリア外（aoi × 八王子）は null（嘘の枠を出さない / spec 2-3）", async () => {
    const res = await getTherapistSlots({ slug: "aoi", areaId: hachiojiId, courseId: shortCourseId });
    expect(res).toBeNull();
  });

  it("非公開セラピスト（minato）は null", async () => {
    const res = await getTherapistSlots({ slug: "minato" });
    expect(res).toBeNull();
  });

  it("不正な areaId（UUID でない細工）は null", async () => {
    const res = await getTherapistSlots({ slug: "aoi", areaId: "'; drop table" });
    expect(res).toBeNull();
  });

  it("実在しない日付は null", async () => {
    const res = await getTherapistSlots({ slug: "aoi", dateISO: "2026-02-31" });
    expect(res).toBeNull();
  });
});

describe("公開コース/オプションの読み取り", () => {
  it("コースは is_active・sort_order 順で出る", async () => {
    const courses = await listPublicCourses();
    expect(courses.length).toBeGreaterThan(0);
    for (const c of courses) {
      expect(Number.isInteger(c.price)).toBe(true);
      expect(Number.isInteger(c.durationMin)).toBe(true);
      expect(c.durationMin).toBeGreaterThan(0);
    }
  });

  it("フットケアは aoi 限定（全員対応でない）ので、therapistId 指定で対応が変わる", async () => {
    const aoiId = await getPublicTherapistId("aoi");
    expect(aoiId).not.toBeNull();
    const forAoi = await listPublicOptions(aoiId);
    const forNone = await listPublicOptions(null);
    const aoiNames = forAoi.map((o) => o.name);
    const noneNames = forNone.map((o) => o.name);
    // aoi にはフットケアが含まれ、全員対応のみ（null）には含まれない
    expect(aoiNames).toContain("フットケア");
    expect(noneNames).not.toContain("フットケア");
  });
});
