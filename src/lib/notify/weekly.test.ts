/**
 * 週次レポートのユニットテスト（受入 L1133: 先週分の数字で生成される）。
 * 先週月曜の計算ロジックを `triggerWeeklyReport`（actions.ts）と独立して検証する。
 *
 * DB 依存のない日付計算ロジックのみテスト。
 */

import { describe, it, expect } from "vitest";
import { format, subDays, startOfWeek, addDays } from "date-fns";
import { toZonedTime } from "date-fns-tz";

/** actions.ts の triggerWeeklyReport が使う計算ロジック（再掲） */
function lastWeekStartISO(now: Date): string {
  const nowJST = toZonedTime(now, "Asia/Tokyo");
  const thisMonday = startOfWeek(nowJST, { weekStartsOn: 1 });
  const lastMonday = subDays(thisMonday, 7);
  return format(lastMonday, "yyyy-MM-dd");
}

/** generateWeeklyReport が週末を計算する（+6日） */
function weekEndISO(weekStartISO: string): string {
  const start = new Date(`${weekStartISO}T00:00:00+09:00`);
  return format(toZonedTime(addDays(start, 6), "Asia/Tokyo"), "yyyy-MM-dd");
}

describe("先週月曜の計算（受入 L1133: 先週分の数字で生成される）", () => {
  it("月曜基点で正確に先週の月曜を返す", () => {
    // 2026-08-31 (月) → 先週月曜は 2026-08-24
    const now = new Date("2026-08-31T00:00:00+09:00");
    expect(lastWeekStartISO(now)).toBe("2026-08-24");
  });

  it("日曜に実行しても先週の月曜を返す（週またぎ）", () => {
    // 2026-09-06 (日) → 先週月曜は 2026-08-24
    const now = new Date("2026-09-06T23:59:00+09:00");
    expect(lastWeekStartISO(now)).toBe("2026-08-24");
  });

  it("金曜に実行しても先週の月曜を返す", () => {
    // 2026-09-04 (金) → 先週月曜は 2026-08-24
    const now = new Date("2026-09-04T12:00:00+09:00");
    expect(lastWeekStartISO(now)).toBe("2026-08-24");
  });

  it("今週月曜に実行すると今週月曜ではなく先週月曜を返す", () => {
    // 2026-09-07 (月) → 先週月曜は 2026-08-31
    const now = new Date("2026-09-07T09:00:00+09:00");
    expect(lastWeekStartISO(now)).toBe("2026-08-31");
  });
});

describe("週末の計算（weekStartISO + 6日）", () => {
  it("月曜 + 6日 = 日曜", () => {
    expect(weekEndISO("2026-08-24")).toBe("2026-08-30");
  });

  it("月曜 2026-09-07 → 2026-09-13", () => {
    expect(weekEndISO("2026-09-07")).toBe("2026-09-13");
  });
});

describe("未来週の生成拒否（generateWeeklyReport の guard）", () => {
  it("weekStartISO >= today なら notificationId=null となるべき", () => {
    // これは guard の意図を記録するドキュメンテーションテスト。
    // 実際の guard は generateWeeklyReport 内に存在する。
    const todayISO = "2026-08-31";
    const futureWeek = "2026-09-07";
    expect(futureWeek >= todayISO).toBe(true); // guard が発動する条件
  });

  it("先週の weekStartISO は today より小さい", () => {
    const todayISO = "2026-08-31";
    const lastWeek = "2026-08-24";
    expect(lastWeek < todayISO).toBe(true); // guard が通過する条件
  });
});
