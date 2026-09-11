import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
import { getTodaysPay, settleTodaysPay, unsettleTodaysPay } from "@/lib/payout/todays-pay-actions";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let aoiId: string;
const DAY = "2099-09-09"; // 衝突回避の未来日

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;
  // reservation_id is required for non-adjustment categories (payout_lines_reservation_required_check).
  // Use adjustment rows (positive amounts allowed) to bypass the constraint in test fixtures.
  // course 20000 + option 5000 + nomination 3000 → represented as 3 adjustment rows = gross 28000
  await sql`insert into payout_lines (therapist_id, business_date, category, amount, calc_note)
            values (${aoiId}::uuid, ${DAY}::date, 'adjustment', 20000, ${sql.json({ t: "test-course" })})`;
  await sql`insert into payout_lines (therapist_id, business_date, category, amount, calc_note)
            values (${aoiId}::uuid, ${DAY}::date, 'adjustment', 3000, ${sql.json({ t: "test-nomination" })})`;
  await sql`insert into payout_lines (therapist_id, business_date, category, amount, calc_note)
            values (${aoiId}::uuid, ${DAY}::date, 'adjustment', 5000, ${sql.json({ t: "test-option" })})`;
});

afterAll(async () => {
  await sql`delete from daily_payouts where therapist_id = ${aoiId}::uuid and business_date = ${DAY}::date`;
  await sql`delete from payout_lines where therapist_id = ${aoiId}::uuid and business_date = ${DAY}::date`;
  await sql.end({ timeout: 5 });
});

describe("getTodaysPay", () => {
  it("当日のバックを集計し雑費10%切り捨てで支払額を出す", async () => {
    const r = await getTodaysPay(DAY);
    expect(r.ok).toBe(true);
    const me = r.data?.find((x) => x.therapistId === aoiId)!;
    expect(me.gross).toBe(28000);
    expect(me.misc).toBe(2800);
    expect(me.pay).toBe(25200);
    expect(me.settled).toBe(false);
  });
});

describe("settleTodaysPay", () => {
  it("精算を記録し、再取得で settled=true", async () => {
    const s = await settleTodaysPay({ therapistId: aoiId, dateISO: DAY });
    expect(s.ok).toBe(true);
    const r = await getTodaysPay(DAY);
    expect(r.data?.find((x) => x.therapistId === aoiId)?.settled).toBe(true);
  });
  it("二重精算は already（冪等・追記専用）", async () => {
    const s = await settleTodaysPay({ therapistId: aoiId, dateISO: DAY });
    expect(s.ok).toBe(true);
    expect(s.data?.already).toBe(true);
  });
});

describe("unsettleTodaysPay", () => {
  it("精算取消で settled=false に戻る", async () => {
    // 精算済み状態を確認してから取消
    const before = await getTodaysPay(DAY);
    expect(before.data?.find((x) => x.therapistId === aoiId)?.settled).toBe(true);

    const u = await unsettleTodaysPay({ therapistId: aoiId, dateISO: DAY });
    expect(u.ok).toBe(true);

    const after = await getTodaysPay(DAY);
    expect(after.data?.find((x) => x.therapistId === aoiId)?.settled).toBe(false);
  });

  it("未精算の取消はエラー（未精算です）", async () => {
    // 先ほど取消したので未精算状態
    const u = await unsettleTodaysPay({ therapistId: aoiId, dateISO: DAY });
    expect(u.ok).toBe(false);
    expect(u.error).toBe("未精算です");
  });
});
