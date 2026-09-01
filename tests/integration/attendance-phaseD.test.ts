import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { getTodayAttendanceCore, punchAttendanceCore } from "@/lib/attendance/queries";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });

// seed の app_users（scripts/seed.ts）
const OWNER: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "owner" };
const AOI: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000004", role: "therapist" };
const REN: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000005", role: "therapist" };

// 他テストと衝突しない未来日で検証（work_date は JST 稼働日）
const NOW = new Date(2027, 0, 15, 18, 0, 0).getTime(); // 2027-01-15 18:00 JST 相当

afterAll(async () => {
  await sql`delete from attendances where work_date = '2027-01-15'`;
  await sql.end();
});

describe("attendance queries (実Postgres)", () => {
  it("出勤→退勤→再打刻: 冪等で二重打刻しない", async () => {
    const t = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    const therapistId = t[0]!.id;

    const a = await withUser(sql, AOI, (tx) =>
      punchAttendanceCore(tx, therapistId, "clock_in", NOW),
    );
    expect(a.clockInAt).not.toBeNull();
    expect(a.status).toBe("working");

    // 同じ clock_in をもう一度 → 冪等（clockInAt は変わらない）
    const a2 = await withUser(sql, AOI, (tx) =>
      punchAttendanceCore(tx, therapistId, "clock_in", NOW + 60_000),
    );
    expect(a2.clockInAt!.getTime()).toBe(a.clockInAt!.getTime());

    // 退勤
    const b = await withUser(sql, AOI, (tx) =>
      punchAttendanceCore(tx, therapistId, "clock_out", NOW + 3_600_000),
    );
    expect(b.clockOutAt).not.toBeNull();
    expect(b.status).toBe("done");

    // 退勤の二度押しも冪等（clockOutAt 不変）
    const b2 = await withUser(sql, AOI, (tx) =>
      punchAttendanceCore(tx, therapistId, "clock_out", NOW + 7_200_000),
    );
    expect(b2.clockOutAt!.getTime()).toBe(b.clockOutAt!.getTime());
  });

  it("work_date は JST 稼働日で確定する", async () => {
    const t = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    const rec = await withUser(sql, AOI, (tx) => getTodayAttendanceCore(tx, t[0]!.id, NOW));
    expect(rec?.workDate).toBe("2027-01-15");
  });

  it("RLS: 他人の当日実績は select できない", async () => {
    const aoi = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    // れんのセッションで あおい の行を読もうとしても null
    const rec = await withUser(sql, REN, (tx) => getTodayAttendanceCore(tx, aoi[0]!.id, NOW));
    expect(rec).toBeNull();
  });

  it("RLS: 他人の therapist_id へは打刻できない（書き込み拒否）", async () => {
    const aoi = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    // れんのセッションで あおい の行を書こうとすると RLS で拒否される
    await expect(
      withUser(sql, REN, (tx) => punchAttendanceCore(tx, aoi[0]!.id, "clock_in", NOW)),
    ).rejects.toThrow();
  });

  it("RLS: owner は誰の実績も読める", async () => {
    const aoi = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    const rec = await withUser(sql, OWNER, (tx) => getTodayAttendanceCore(tx, aoi[0]!.id, NOW));
    expect(rec?.workDate).toBe("2027-01-15");
  });
});
