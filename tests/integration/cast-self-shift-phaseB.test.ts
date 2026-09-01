import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { upsertMyShiftCore } from "@/lib/shifts/self-queries";
import { enumerateShiftDates } from "@/domain/shifts/dates";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });

// seed の app_users（scripts/seed.ts）。aoi=…004 は therapist_id 紐付け済み、ren=…005。
const AOI: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000004", role: "therapist" };
const REN: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000005", role: "therapist" };

// 他テストと衝突しない未来日（bulk-b は 2027-03 を使うため避ける）。全て 2029-11。
const WD1 = "2029-11-13";
const WD2 = "2029-11-14";
const WD3 = "2029-11-15";

afterAll(async () => {
  await sql`delete from shifts where work_date >= '2029-11-01' and work_date < '2029-12-01'`;
  await sql.end();
});

describe("cast self shift (実Postgres)", () => {
  it("本人は自分の出勤を登録でき、全アクティブエリアが付与される", async () => {
    const t = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    const therapistId = t[0]!.id;
    const active = await sql<{ c: number }[]>`select count(*)::int c from areas where is_active = true`;

    const r = await withUser(sql, AOI, (tx) =>
      upsertMyShiftCore(tx, therapistId, WD1, "18:00", "23:00"),
    );
    expect(r.id).toBeTruthy();
    expect(r.areaCount).toBe(active[0]!.c);

    // shifts が1行できている
    const s = await sql<{ c: number }[]>`
      select count(*)::int c from shifts where therapist_id = ${therapistId} and work_date = ${WD1}
    `;
    expect(s[0]!.c).toBe(1);
  });

  it("再登録は冪等（time 更新・エリア重複なし）", async () => {
    const t = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    const therapistId = t[0]!.id;
    const active = await sql<{ c: number }[]>`select count(*)::int c from areas where is_active = true`;

    const r = await withUser(sql, AOI, (tx) =>
      upsertMyShiftCore(tx, therapistId, WD1, "17:30", "23:30"),
    );
    expect(r.areaCount).toBe(active[0]!.c);

    const sarea = await sql<{ c: number }[]>`
      select count(*)::int c from shift_areas sa
      join shifts s on s.id = sa.shift_id
      where s.therapist_id = ${therapistId} and s.work_date = ${WD1}
    `;
    expect(sarea[0]!.c).toBe(active[0]!.c);
  });

  it("RLS: 他人の therapist_id へは登録できない", async () => {
    const aoi = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    // れんのセッションで あおい の出勤を作ろうとしても RLS insert with-check で拒否
    await expect(
      withUser(sql, REN, (tx) => upsertMyShiftCore(tx, aoi[0]!.id, WD2, "18:00", "23:00")),
    ).rejects.toThrow();
  });

  it("RLS: 他人の shift の shift_areas は追加できない", async () => {
    const aoi = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    // あおいが自分の shift を作る
    await withUser(sql, AOI, (tx) => upsertMyShiftCore(tx, aoi[0]!.id, WD3, "18:00", "23:00"));
    const shift = await sql<{ id: string }[]>`
      select id from shifts where therapist_id = ${aoi[0]!.id} and work_date = ${WD3} limit 1
    `;
    const area = await sql<{ id: string }[]>`select id from areas where is_active = true limit 1`;
    // れんセッションで あおいの shift に shift_areas を挿そうとしても with-check で拒否
    await expect(
      withUser(sql, REN, (tx) =>
        tx`insert into shift_areas (shift_id, area_id) values (${shift[0]!.id}, ${area[0]!.id})`,
      ),
    ).rejects.toThrow();
  });

  it("一括: 期間×曜日で複数日ぶん登録される（enumerateShiftDates 展開）", async () => {
    const aoi = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    const dates = enumerateShiftDates("2029-11-19", "2029-11-30", [1, 4]); // 月・木
    expect(dates.length).toBeGreaterThan(1);
    await withUser(sql, AOI, async (tx) => {
      for (const d of dates) await upsertMyShiftCore(tx, aoi[0]!.id, d, "18:00", "23:00");
    });
    const rows = await sql<{ c: number }[]>`
      select count(*)::int c from shifts
      where therapist_id = ${aoi[0]!.id} and work_date = any(${dates})
    `;
    expect(rows[0]!.c).toBe(dates.length);
  });
});
