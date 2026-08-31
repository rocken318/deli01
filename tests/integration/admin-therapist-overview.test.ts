import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { getTherapistMonthOverview } from "@/lib/admin/therapist-overview";

/**
 * 管理側「セラピストごとの月間出勤＋稼ぎ」overview の統合テスト（実 Postgres）。
 * 前提: ADMIN_DEV_SESSION=1（getDevSession が owner を返す）。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const enabled = process.env.ADMIN_DEV_SESSION === "1";
const thisMonth = format(toZonedTime(new Date(), "Asia/Tokyo"), "yyyy-MM");

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe.skipIf(!enabled)("getTherapistMonthOverview（管理・任意セラピスト閲覧）", () => {
  beforeAll(async () => {
    const t = await sql<{ c: number }[]>`select count(*)::int c from therapists where slug='aoi'`;
    expect(t[0]!.c).toBe(1);
  });

  it("aoi の当月 overview: 出勤日・予約件数・稼ぎ合計を返す", async () => {
    const outcome = await getTherapistMonthOverview({ slug: "aoi", monthISO: thisMonth });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const d = outcome.data;
    expect(d.displayName.length).toBeGreaterThan(0);
    // aoi は当月に出勤（seed: today..+4 のうち当月分）
    const working = d.days.filter((x) => x.hasShift && !x.isDayOff);
    expect(working.length).toBeGreaterThanOrEqual(1);
    for (const x of working) expect(x.startHHmm).toBe("10:00");
    // 稼ぎは整数円・合計は各カテゴリ合計と一致
    expect(Number.isInteger(d.earnings.monthTotal)).toBe(true);
    const sum = d.earnings.byCategory.reduce((s, c) => s + c.amount, 0);
    expect(sum).toBe(d.earnings.monthTotal);
    expect(d.shiftDays).toBe(working.length);
  });

  it("存在しない slug は not_found", async () => {
    const outcome = await getTherapistMonthOverview({ slug: "no-such", monthISO: thisMonth });
    expect(outcome.kind).toBe("not_found");
  });

  it("不正な月フォーマットは not_found", async () => {
    const outcome = await getTherapistMonthOverview({ slug: "aoi", monthISO: "2026-13" });
    expect(outcome.kind).toBe("not_found");
  });
});
