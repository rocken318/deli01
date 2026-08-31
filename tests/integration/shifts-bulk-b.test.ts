import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

// revalidatePath はリクエストコンテキスト外だと動かないため no-op 化
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  enumerateShiftDates,
  saveShiftsBulkAction,
} from "@/lib/cms/shift-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const enabled = process.env.ADMIN_DEV_SESSION === "1";
// seed を壊さない遠い未来（他テストは today 基準）
const R_START = "2027-03-01";
const R_END = "2027-03-31";

let aoiId = "";
let areaId = "";

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`select id from therapists where slug = 'aoi'`;
  aoiId = t[0]?.id ?? "";
  const a = await sql<{ id: string }[]>`select id from areas where is_active = true order by sort_order limit 1`;
  areaId = a[0]?.id ?? "";
});

afterAll(async () => {
  await sql`delete from shifts where work_date >= '2027-01-01'`;
  await sql.end({ timeout: 5 });
});

describe("enumerateShiftDates（純関数）", () => {
  it("期間内の指定曜日だけを列挙する", () => {
    // 2027-03: 月曜は 1,8,15,22,29
    const mondays = enumerateShiftDates("2027-03-01", "2027-03-31", [1]);
    expect(mondays).toEqual([
      "2027-03-01",
      "2027-03-08",
      "2027-03-15",
      "2027-03-22",
      "2027-03-29",
    ]);
  });

  it("複数曜日を指定できる（月・水・金）", () => {
    const days = enumerateShiftDates("2027-03-01", "2027-03-07", [1, 3, 5]);
    expect(days).toEqual(["2027-03-01", "2027-03-03", "2027-03-05"]);
  });

  it("終了日が開始日より前なら throw", () => {
    expect(() => enumerateShiftDates("2027-03-10", "2027-03-01", [1])).toThrow();
  });

  it("100日を超えると throw（毎日×長期）", () => {
    expect(() =>
      enumerateShiftDates("2027-01-01", "2027-12-31", [0, 1, 2, 3, 4, 5, 6]),
    ).toThrow(/100/);
  });
});

describe.skipIf(!enabled)("saveShiftsBulkAction（一括登録・冪等）", () => {
  function buildForm(): FormData {
    const fd = new FormData();
    fd.set("therapistId", aoiId);
    fd.set("rangeStart", R_START);
    fd.set("rangeEnd", R_END);
    fd.append("weekdays", "1"); // 月曜
    fd.set("start", "11:00");
    fd.set("end", "20:00");
    fd.set("maxBookings", "4");
    fd.set("note", "一括登録テスト");
    fd.append("areaIds", areaId);
    return fd;
  }

  it("期間内の月曜すべてに出勤が作られ、対応エリアも設定される", async () => {
    await saveShiftsBulkAction(buildForm());

    const rows = await sql<{ work_date: string; max_bookings: number; is_day_off: boolean }[]>`
      select to_char(work_date, 'YYYY-MM-DD') as work_date, max_bookings, is_day_off
      from shifts
      where therapist_id = ${aoiId}::uuid and work_date >= '2027-01-01'
      order by work_date
    `;
    expect(rows.map((r) => r.work_date)).toEqual([
      "2027-03-01",
      "2027-03-08",
      "2027-03-15",
      "2027-03-22",
      "2027-03-29",
    ]);
    expect(rows.every((r) => r.max_bookings === 4 && !r.is_day_off)).toBe(true);

    const areaLink = await sql<{ n: number }[]>`
      select count(*)::int as n
      from shift_areas sa
      join shifts s on s.id = sa.shift_id
      where s.therapist_id = ${aoiId}::uuid and s.work_date >= '2027-01-01'
        and sa.area_id = ${areaId}::uuid
    `;
    expect(areaLink[0]!.n).toBe(5);
  });

  it("2回目の一括登録でも重複行が増えない（upsert 冪等）", async () => {
    await saveShiftsBulkAction(buildForm());
    const cnt = await sql<{ n: number }[]>`
      select count(*)::int as n from shifts
      where therapist_id = ${aoiId}::uuid and work_date >= '2027-01-01'
    `;
    expect(cnt[0]!.n).toBe(5);
  });

  it("曜日未選択は拒否（バリデーション）", async () => {
    const fd = buildForm();
    fd.delete("weekdays");
    await expect(saveShiftsBulkAction(fd)).rejects.toThrow();
  });
});
