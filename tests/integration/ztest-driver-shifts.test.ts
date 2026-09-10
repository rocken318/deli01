import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  getDriverWeek,
  saveDriverWeek,
  copyPreviousWeek,
  listActiveDriversForDate,
} from "@/lib/drivers/shift-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let driverId: string;

beforeAll(async () => {
  const rows = await sql<{ id: string }[]>`
    insert into drivers (name, vehicle_color_hex, vehicle_color_name)
    values ('シフトテスト運転手', '#123456', 'テスト色') returning id
  `;
  driverId = rows[0]!.id;
});

afterAll(async () => {
  await sql`delete from drivers where id = ${driverId}::uuid`; // cascade で週/日も消える
  await sql.end({ timeout: 5 });
});

const W1 = "2026-09-07"; // 月曜
const W2 = "2026-09-14"; // 翌週 月曜

describe("saveDriverWeek / getDriverWeek", () => {
  it("保存した曜日とメモを取得できる", async () => {
    const save = await saveDriverWeek({
      driverId,
      weekStart: W1,
      memo: "車検 9/23",
      days: [
        { dow: 0, start: "11:00", end: "23:00" },
        { dow: 5, start: "20:00", end: "27:00" }, // 土 25時超え
      ],
    });
    expect(save.ok).toBe(true);

    const got = await getDriverWeek(driverId, W1);
    expect(got.ok).toBe(true);
    expect(got.data?.memo).toBe("車検 9/23");
    const sat = got.data?.days.find((d) => d.dow === 5);
    expect(sat?.start).toBe("20:00");
    expect(sat?.end).toBe("27:00");
  });

  it("翌週はメモを引き継ぐ（days は空）", async () => {
    const got = await getDriverWeek(driverId, W2);
    expect(got.ok).toBe(true);
    expect(got.data?.memo).toBe("車検 9/23");
    expect(got.data?.days.length).toBe(0);
  });
});

describe("copyPreviousWeek", () => {
  it("前週の曜日とメモを複製する", async () => {
    const r = await copyPreviousWeek(driverId, W2);
    expect(r.ok).toBe(true);
    const got = await getDriverWeek(driverId, W2);
    expect(got.data?.days.length).toBe(2);
    expect(got.data?.memo).toBe("車検 9/23");
  });
});

describe("listActiveDriversForDate", () => {
  it("稼働曜日（月=2026-09-07）に当該ドライバーが出る", async () => {
    const r = await listActiveDriversForDate("2026-09-07");
    expect(r.ok).toBe(true);
    const found = r.data?.find((d) => d.id === driverId);
    expect(found).toBeDefined();
    expect(found?.start).toBe("11:00");
  });
  it("非稼働曜日（火=2026-09-08）には出ない", async () => {
    const r = await listActiveDriversForDate("2026-09-08");
    const found = r.data?.find((d) => d.id === driverId);
    expect(found).toBeUndefined();
  });
});
