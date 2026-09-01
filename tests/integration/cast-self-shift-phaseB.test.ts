import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { upsertMyShiftCore } from "@/lib/shifts/self-queries";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });

// seed の app_users（scripts/seed.ts）。aoi=…004 は therapist_id 紐付け済み、ren=…005。
const AOI: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000004", role: "therapist" };
const REN: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000005", role: "therapist" };

// 他テストと衝突しない未来日（bulk-b は 2027-03 を使うため避ける）
const WD1 = "2029-11-13";
const WD2 = "2029-11-14";

afterAll(async () => {
  await sql`delete from shifts where work_date in (${WD1}, ${WD2})`;
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
});
