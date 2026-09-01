import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";
import { getMyAttendanceToday } from "@/lib/dispatch-board/therapist-portal-actions";

/**
 * getMyAttendanceToday（マイページの出退勤ステータス表示）。
 * 前提: ADMIN_DEV_SESSION=1（getTherapistDevSession が ?as=aoi を解決）。
 */
const enabled = process.env.ADMIN_DEV_SESSION === "1";
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });
const TZ = "Asia/Tokyo";
const WD = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");

afterAll(async () => {
  await sql`delete from attendances where work_date = ${WD}
    and therapist_id = (select id from therapists where slug='aoi' limit 1)`;
  await sql.end();
});

beforeAll(async () => {
  // クリーン状態から
  await sql`delete from attendances where work_date = ${WD}
    and therapist_id = (select id from therapists where slug='aoi' limit 1)`;
});

describe("getMyAttendanceToday (実Postgres)", () => {
  it("未打刻なら clockInAt は null", async () => {
    if (!enabled) return;
    const r = await getMyAttendanceToday("aoi");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data?.clockInAt).toBeNull();
  });

  it("出勤打刻があれば clockInAt が返る", async () => {
    if (!enabled) return;
    await sql`
      insert into attendances (therapist_id, work_date, clock_in_at, status)
      values ((select id from therapists where slug='aoi' limit 1), ${WD}, now(), 'working')
      on conflict (therapist_id, work_date) do update set clock_in_at = excluded.clock_in_at
    `;
    const r = await getMyAttendanceToday("aoi");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data?.clockInAt).not.toBeNull();
      expect(r.data?.status).toBe("working");
    }
  });
});
