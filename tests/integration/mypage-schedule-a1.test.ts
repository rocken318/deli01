import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import type { Session } from "@/lib/auth/session";
import {
  getMyMonthlyScheduleCore,
  getMyReservationsCore,
} from "@/lib/dispatch-board/mypage-schedule";

/**
 * A1: キャストの出勤カレンダー / 予約一覧 コアクエリの統合テスト（実 Postgres）。
 * RLS により本人分だけが返ること・月集計・forbidden を確認する。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const sessions = new Map<string, Session>();
const APP_TZ = "Asia/Tokyo";
const thisMonth = format(toZonedTime(new Date(), APP_TZ), "yyyy-MM");
const todayISO = format(toZonedTime(new Date(), APP_TZ), "yyyy-MM-dd");

function sess(slug: string): Session {
  const s = sessions.get(slug);
  if (!s) throw new Error(`seed に therapist ${slug} がいない`);
  return s;
}

beforeAll(async () => {
  const rows = await sql<{ user_id: string; therapist_id: string; slug: string }[]>`
    select au.id as user_id, au.therapist_id, t.slug
    from app_users au
    join therapists t on t.id = au.therapist_id
    where t.slug in ('aoi', 'ren')
  `;
  for (const r of rows) {
    sessions.set(r.slug, {
      userId: r.user_id,
      role: "therapist",
      therapistId: r.therapist_id,
    });
  }
  expect(sessions.has("aoi")).toBe(true);
  expect(sessions.has("ren")).toBe(true);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("getMyMonthlyScheduleCore（本人の出勤カレンダー）", () => {
  it("aoi の当月に出勤日が入り、すべて aoi のシフト時間(10:00-19:00)である", async () => {
    const outcome = await getMyMonthlyScheduleCore(sql, sess("aoi"), thisMonth);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const shiftDays = outcome.days.filter((d) => d.hasShift && !d.isDayOff);
    expect(shiftDays.length).toBeGreaterThanOrEqual(1);
    // ren のシフト(12:00-22:00)が混ざっていないこと = RLS 本人限定の実証
    for (const d of shiftDays) {
      expect(d.startHHmm).toBe("10:00");
      expect(d.endHHmm).toBe("19:00");
    }
    // 日付は昇順
    const iso = outcome.days.map((d) => d.dateISO);
    expect([...iso].sort()).toEqual(iso);
  });

  it("ren は自分のシフト時間(12:00-22:00)で返る（本人ごとに異なる）", async () => {
    const outcome = await getMyMonthlyScheduleCore(sql, sess("ren"), thisMonth);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const working = outcome.days.filter((d) => d.hasShift && !d.isDayOff);
    expect(working.length).toBeGreaterThanOrEqual(1);
    for (const d of working) expect(d.startHHmm).toBe("12:00");
    // 当日欠勤(is_day_off)の日が1日ある（seed: ren +2日）
    expect(outcome.days.some((d) => d.isDayOff)).toBe(true);
  });

  it("非セラピスト（owner）は forbidden", async () => {
    const ownerRows = await sql<{ id: string }[]>`
      select id from app_users where role = 'owner' limit 1
    `;
    const owner: Session = { userId: ownerRows[0]!.id, role: "owner" };
    const outcome = await getMyMonthlyScheduleCore(sql, owner, thisMonth);
    expect(outcome.kind).toBe("forbidden");
  });

  it("不正な月フォーマットは throw", async () => {
    await expect(
      getMyMonthlyScheduleCore(sql, sess("aoi"), "2026-13"),
    ).rejects.toThrow();
  });
});

describe("getMyReservationsCore（本人の予約一覧）", () => {
  it("aoi の今日以降の予約は start 昇順・可視ステータスのみ", async () => {
    const outcome = await getMyReservationsCore(sql, sess("aoi"), todayISO);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const visible = new Set(["confirmed", "enroute", "in_service", "done"]);
    for (const r of outcome.items) {
      expect(visible.has(r.status)).toBe(true);
      expect(r.dateISO >= todayISO).toBe(true);
      expect(r.courseName.length).toBeGreaterThan(0);
    }
    const starts = outcome.items.map((r) => `${r.dateISO} ${r.startHHmm}`);
    expect([...starts].sort()).toEqual(starts);
  });

  it("非セラピストは forbidden", async () => {
    const ownerRows = await sql<{ id: string }[]>`
      select id from app_users where role = 'owner' limit 1
    `;
    const owner: Session = { userId: ownerRows[0]!.id, role: "owner" };
    const outcome = await getMyReservationsCore(sql, owner, todayISO);
    expect(outcome.kind).toBe("forbidden");
  });
});
