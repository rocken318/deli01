import { describe, expect, it } from "vitest";
import { flashDiscount, isFlashEligible } from "./flash";
import type { FlashDealConfig } from "./flash";

// ---------------------------------------------------------------------------
// flashDiscount（★金銭: 整数円・floor 切り捨て）
// ---------------------------------------------------------------------------

describe("flashDiscount", () => {
  it("floor(base × rate / 100) を整数で返す", () => {
    expect(flashDiscount({ baseAmount: 16000, ratePercent: 10 })).toBe(1600);
    expect(flashDiscount({ baseAmount: 10333, ratePercent: 10 })).toBe(1033); // 1033.3 → 1033
    expect(flashDiscount({ baseAmount: 999, ratePercent: 15 })).toBe(149); // 149.85 → 149
  });

  it("端は 0% → 0 / 100% → 全額", () => {
    expect(flashDiscount({ baseAmount: 16000, ratePercent: 0 })).toBe(0);
    expect(flashDiscount({ baseAmount: 16000, ratePercent: 100 })).toBe(16000);
  });

  it("base 0 → 0（0 円予約に負の割引を作らない）", () => {
    expect(flashDiscount({ baseAmount: 0, ratePercent: 10 })).toBe(0);
  });

  it("不正入力は throw（金銭計算は fail fast: 小数・負・範囲外）", () => {
    expect(() => flashDiscount({ baseAmount: 100.5, ratePercent: 10 })).toThrow();
    expect(() => flashDiscount({ baseAmount: -1, ratePercent: 10 })).toThrow();
    expect(() => flashDiscount({ baseAmount: 100, ratePercent: 10.5 })).toThrow();
    expect(() => flashDiscount({ baseAmount: 100, ratePercent: 101 })).toThrow();
    expect(() => flashDiscount({ baseAmount: 100, ratePercent: -1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isFlashEligible（spec L652: 当日・発火時刻・時間帯・コース・1日上限）
// ---------------------------------------------------------------------------

const CONFIG: FlashDealConfig = {
  enabled: true,
  ratePercent: 10,
  windowFromHour: 18,
  windowToHour: 24,
  dailyLimit: 3,
  courseIds: [],
  triggerHour: 15,
};

const BASE = {
  config: CONFIG,
  startHourJst: 19,
  nowHourJst: 16,
  isSameDayJst: true,
  courseId: "course-a",
  appliedTodayCount: 0,
};

describe("isFlashEligible", () => {
  it("全条件を満たせば eligible", () => {
    expect(isFlashEligible(BASE)).toEqual({ eligible: true });
  });

  it("enabled=false → disabled（既定は無効 = 設定されるまで金が動かない）", () => {
    expect(
      isFlashEligible({ ...BASE, config: { ...CONFIG, enabled: false } }),
    ).toEqual({ eligible: false, reason: "disabled" });
  });

  it("当日でない → not_same_day", () => {
    expect(isFlashEligible({ ...BASE, isSameDayJst: false })).toEqual({
      eligible: false,
      reason: "not_same_day",
    });
  });

  it("発火時刻前 → before_trigger（trigger ちょうどは可）", () => {
    expect(isFlashEligible({ ...BASE, nowHourJst: 14 })).toEqual({
      eligible: false,
      reason: "before_trigger",
    });
    expect(isFlashEligible({ ...BASE, nowHourJst: 15 })).toEqual({ eligible: true });
  });

  it("時間帯は [from, to) の半開区間", () => {
    expect(isFlashEligible({ ...BASE, startHourJst: 17 })).toEqual({
      eligible: false,
      reason: "outside_window",
    });
    expect(isFlashEligible({ ...BASE, startHourJst: 18 })).toEqual({ eligible: true });
    expect(isFlashEligible({ ...BASE, startHourJst: 23 })).toEqual({ eligible: true });
    // windowToHour=24 は「その日の末尾まで」= JST の時 0..23 は超えない
    expect(
      isFlashEligible({
        ...BASE,
        config: { ...CONFIG, windowToHour: 22 },
        startHourJst: 22,
      }),
    ).toEqual({ eligible: false, reason: "outside_window" });
  });

  it("course_ids 空 = 全コース対象 / 指定時は含まれるコースだけ", () => {
    const limited = { ...CONFIG, courseIds: ["course-b"] };
    expect(isFlashEligible({ ...BASE, config: limited })).toEqual({
      eligible: false,
      reason: "course_not_covered",
    });
    expect(
      isFlashEligible({ ...BASE, config: limited, courseId: "course-b" }),
    ).toEqual({ eligible: true });
  });

  it("1日上限に達したら daily_limit_reached（受入 L1120）", () => {
    expect(isFlashEligible({ ...BASE, appliedTodayCount: 2 })).toEqual({
      eligible: true,
    });
    expect(isFlashEligible({ ...BASE, appliedTodayCount: 3 })).toEqual({
      eligible: false,
      reason: "daily_limit_reached",
    });
    // dailyLimit 0 = 実質停止
    expect(
      isFlashEligible({
        ...BASE,
        config: { ...CONFIG, dailyLimit: 0 },
        appliedTodayCount: 0,
      }),
    ).toEqual({ eligible: false, reason: "daily_limit_reached" });
  });
});
