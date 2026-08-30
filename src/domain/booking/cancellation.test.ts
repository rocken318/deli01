import { describe, it, expect } from "vitest";
import {
  cancellationFee,
  cancellationPercent,
  DEFAULT_CANCELLATION_POLICY,
  AFTER_START_PERCENT,
  type CancellationTier,
} from "./cancellation";

/**
 * キャンセル料の算定（フェーズ15 / spec 6章 L648・11-2）。
 * 既定雛形: 24h前まで0% / 3h前まで30% / 当日(開始前)50% / 開始後・noshow 100%。
 */
describe("cancellationPercent – 段階制の請求率", () => {
  it("24時間以上前は 0%", () => {
    expect(cancellationPercent({ hoursBeforeStart: 48 })).toBe(0);
    expect(cancellationPercent({ hoursBeforeStart: 24 })).toBe(0); // 境界ちょうど
  });

  it("3〜24時間前は 30%", () => {
    expect(cancellationPercent({ hoursBeforeStart: 23.9 })).toBe(30);
    expect(cancellationPercent({ hoursBeforeStart: 3 })).toBe(30); // 境界ちょうど
  });

  it("開始前 0〜3時間は 50%", () => {
    expect(cancellationPercent({ hoursBeforeStart: 2.9 })).toBe(50);
    expect(cancellationPercent({ hoursBeforeStart: 0 })).toBe(50); // 境界ちょうど
  });

  it("開始後（負値）は全額 100%", () => {
    expect(cancellationPercent({ hoursBeforeStart: -0.1 })).toBe(AFTER_START_PERCENT);
    expect(AFTER_START_PERCENT).toBe(100);
  });

  it("noshow は残り時間に関わらず全額", () => {
    expect(cancellationPercent({ hoursBeforeStart: 100, isNoShow: true })).toBe(100);
  });
});

describe("cancellationFee – 金額（整数円・切り捨て）", () => {
  it("基礎額 × 率 / 100 を切り捨て", () => {
    expect(cancellationFee({ hoursBeforeStart: 1, baseAmount: 12000 })).toBe(6000); // 50%
    expect(cancellationFee({ hoursBeforeStart: 5, baseAmount: 12000 })).toBe(3600); // 30%
    expect(cancellationFee({ hoursBeforeStart: 48, baseAmount: 12000 })).toBe(0); // 0%
  });

  it("端数は切り捨て", () => {
    // 30% of 999 = 299.7 → 299
    expect(cancellationFee({ hoursBeforeStart: 5, baseAmount: 999 })).toBe(299);
  });

  it("noshow は基礎額の全額", () => {
    expect(
      cancellationFee({ hoursBeforeStart: 100, baseAmount: 12000, isNoShow: true }),
    ).toBe(12000);
  });

  it("非整数の基礎額は RangeError", () => {
    expect(() => cancellationFee({ hoursBeforeStart: 1, baseAmount: 100.5 })).toThrow(
      RangeError,
    );
  });

  it("percent が 100 超のポリシーは RangeError", () => {
    const bad: CancellationTier[] = [{ minHoursBefore: 0, percent: 120 }];
    expect(() =>
      cancellationPercent({ policy: bad, hoursBeforeStart: 1 }),
    ).toThrow(RangeError);
  });

  it("既定ポリシーは3段", () => {
    expect(DEFAULT_CANCELLATION_POLICY).toHaveLength(3);
  });
});
