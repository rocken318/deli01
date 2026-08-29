import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { earliestSlotForTherapist } from "@/lib/availability/earliest";

/**
 * フェーズ9 の統合テスト（実 Postgres / spec 5-4「最短で案内できる時間」）。
 *
 * エンジン本体（spec 5-3 の全ケース）は src/domain/availability/engine.test.ts の
 * 純粋関数テストで固定済み。ここでは公開側配線 earliestSlotForTherapist が
 * シードの実データ（shift・bases・walk_settings・travel_buffers）から値を
 * 引けることを検証する。
 *
 * 前提: pnpm db:reset 済み。シードは実行日基準 +0〜+4 日の shift を入れるため
 * now は実時刻のまま使う（今日の枠が締切後でも翌日の shift で値が出る）。
 * - aoi: published・徒歩派（車不可）・事務所（渋谷）発着・渋谷/恵比寿/目黒のみ対応
 * - minato: 未公開（出勤があっても公開側に出さない）
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

let hachiojiId = "";
let shibuyaId = "";

beforeAll(async () => {
  const areas = await sql<{ id: string; name: string }[]>`
    select id, name from areas where name in ('八王子市', '渋谷区')
  `;
  hachiojiId = areas.find((a) => a.name === "八王子市")?.id ?? "";
  shibuyaId = areas.find((a) => a.name === "渋谷区")?.id ?? "";
  expect(hachiojiId).not.toBe("");
  expect(shibuyaId).not.toBe("");
});

afterAll(async () => {
  await sql.end();
});

describe("earliestSlotForTherapist（spec 5-4 / 最小配線）", () => {
  it("公開セラピスト（aoi）はエリア未指定でも代表エリア概算で時刻が出る", async () => {
    const info = await earliestSlotForTherapist("aoi");
    expect(info).not.toBeNull();
    // "HH:mm"・15分グリッド（spec 5-3 手順7）
    expect(info!.time).toMatch(/^([01]\d|2[0-3]):(00|15|30|45)$/);
    // エリア未指定 → 代表エリア（sort_order 先頭 = 渋谷区）の概算で「〇〇区の場合」表示
    expect(info!.assumed).toBe(true);
    expect(info!.areaId).toBe(shibuyaId);
    expect(info!.areaName).toBe("渋谷区");
    expect(info!.dateISO).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("エリア指定（対応エリア内）は概算でなく確定計算（assumed=false）", async () => {
    const info = await earliestSlotForTherapist("aoi", { areaId: shibuyaId });
    expect(info).not.toBeNull();
    expect(info!.assumed).toBe(false);
    expect(info!.areaId).toBe(shibuyaId);
  });

  it("対応エリア外（aoi × 八王子市）は null（spec 5-3 手順2）", async () => {
    const info = await earliestSlotForTherapist("aoi", { areaId: hachiojiId });
    expect(info).toBeNull();
  });

  it("未公開セラピスト（minato）は出勤があっても null", async () => {
    const info = await earliestSlotForTherapist("minato");
    expect(info).toBeNull();
  });

  it("存在しない slug は null", async () => {
    const info = await earliestSlotForTherapist("no-such-therapist");
    expect(info).toBeNull();
  });

  it("serviceMinutes（L = コース + オプション）を伸ばすと開始時刻が同じか後ろになる", async () => {
    const short = await earliestSlotForTherapist("aoi", { serviceMinutes: 60 });
    const long = await earliestSlotForTherapist("aoi", { serviceMinutes: 240 });
    expect(short).not.toBeNull();
    // 240分でも枠自体は出る想定（10:00-19:00 シフト）。出る場合は開始が前倒しにならない
    if (long) {
      expect(`${long.dateISO} ${long.time}` >= `${short!.dateISO} ${short!.time}`).toBe(true);
    }
  });
});
