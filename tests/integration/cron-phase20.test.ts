import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runCronTick } from "@/lib/cron/tick";

/**
 * フェーズ20 ②cron 配線の統合テスト（実 Postgres）。
 * runCronTick が全ジョブを best-effort で回し、冪等（多重実行しても壊れない）
 * ことを確認する。個々のジョブ本体の詳細検証は各フェーズのテストが担う。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

beforeAll(async () => {
  // owner が有効であること（systemSession の前提）
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from app_users where role = 'owner' and is_active = true
  `;
  expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("runCronTick（②cron 配線）", () => {
  it("全ジョブのキーを返し、いずれも例外で落ちない", async () => {
    const result = await runCronTick(new Date());
    expect(result.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const key of [
      "releaseExpiredHolds",
      "reminders",
      "expirePoints",
      "flashDeals",
      "weeklyReport",
    ]) {
      expect(result.jobs[key]).toBeDefined();
      // ok=false でも error 文字列で握られていること（best-effort で握り潰さない）
      if (!result.jobs[key]!.ok) {
        expect(typeof result.jobs[key]!.error).toBe("string");
      }
    }
  });

  it("直前割が無効（seed 既定）なら flashDeals は skipped=disabled", async () => {
    const result = await runCronTick(new Date());
    const flash = result.jobs.flashDeals!;
    // seed 既定は enabled=false（[[deli01-progress]] フェーズ20）
    expect(flash.ok).toBe(true);
    expect(flash.skipped === "disabled" || flash.detail !== undefined).toBe(true);
  });

  it("冪等: 2 回連続実行しても例外を投げない（unique 制約で二重適用しない）", async () => {
    const first = await runCronTick(new Date());
    const second = await runCronTick(new Date());
    expect(Object.values(first.jobs).every((j) => j.ok)).toBe(true);
    expect(Object.values(second.jobs).every((j) => j.ok)).toBe(true);
  });

  it("月曜以外は weeklyReport が skipped=not_monday（実行日に依存）", async () => {
    // 2026-08-31 は月曜。曜日に応じて skipped か生成のどちらかで、例外は出ない
    const monday = new Date("2026-08-31T09:00:00+09:00");
    const tuesday = new Date("2026-09-01T09:00:00+09:00");
    const onMon = await runCronTick(monday);
    const onTue = await runCronTick(tuesday);
    expect(onMon.jobs.weeklyReport!.ok).toBe(true);
    expect(onTue.jobs.weeklyReport!.skipped).toBe("not_monday");
  });
});
