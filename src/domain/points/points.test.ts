import { describe, expect, it } from "vitest";
import {
  balance,
  clampUse,
  consumeFifo,
  earnedPoints,
  expiredLots,
  expiring,
  sumLedger,
  type PointLot,
} from "./index";

/**
 * ポイント台帳 純関数の最小テスト（フェーズ16。網羅は qa 後続）。
 * 観点: 残高 sum / FIFO（古い付与から）/ 期限切れ除外 / 不足 / 失効30日前 /
 *       付与率切り捨て / 上限・下限 / 整数以外は RangeError。
 */

const T0 = new Date("2026-08-01T00:00:00+09:00");
const T1 = new Date("2026-08-10T00:00:00+09:00");
const NOW = new Date("2026-08-30T12:00:00+09:00");

function lot(id: string, remaining: number, occurredAt: Date, expiresAt: Date | null): PointLot {
  return { lotId: id, remaining, occurredAt, expiresAt };
}

describe("balance / sumLedger", () => {
  it("残高 = sum(points)。空は 0", () => {
    expect(balance([])).toBe(0);
    expect(balance([{ points: 500 }, { points: -120 }, { points: 30 }])).toBe(410);
  });

  it("小数は RangeError（金額・ポイントは整数のみ）", () => {
    expect(() => sumLedger([100.5])).toThrow(RangeError);
    expect(() => balance([{ points: 0.1 }])).toThrow(RangeError);
  });
});

describe("consumeFifo（spec L837 先入先出）", () => {
  it("古いロットから消費し、跨ぐと内訳が分かれる", () => {
    const result = consumeFifo({
      lots: [
        lot("2", 400, T1, null), // 新しい
        lot("1", 300, T0, null), // 古い（順不同で渡しても occurredAt 順）
      ],
      usePoints: 350,
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      total: 350,
      consumption: [
        { lotId: "1", amount: 300 },
        { lotId: "2", amount: 50 },
      ],
    });
  });

  it("期限切れロットは消費対象外", () => {
    const expired = lot("1", 1000, T0, new Date("2026-08-20T00:00:00+09:00"));
    const alive = lot("2", 200, T1, null);
    const result = consumeFifo({ lots: [expired, alive], usePoints: 300, now: NOW });
    expect(result).toEqual({ ok: false, reason: "insufficient", available: 200, shortage: 100 });
  });

  it("残高不足は throw せず shortage を返す", () => {
    const result = consumeFifo({ lots: [lot("1", 100, T0, null)], usePoints: 150, now: NOW });
    expect(result).toEqual({ ok: false, reason: "insufficient", available: 100, shortage: 50 });
  });

  it("usePoints が 0 以下・小数は RangeError", () => {
    expect(() => consumeFifo({ lots: [], usePoints: 0, now: NOW })).toThrow(RangeError);
    expect(() => consumeFifo({ lots: [], usePoints: 10.5, now: NOW })).toThrow(RangeError);
  });

  it("同時刻ロットは id（追記順）で安定に並ぶ", () => {
    const result = consumeFifo({
      lots: [lot("10", 100, T0, null), lot("9", 100, T0, null)],
      usePoints: 150,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.consumption.map((c) => c.lotId)).toEqual(["9", "10"]);
    }
  });
});

describe("expiring（spec L841 失効30日前の一覧）", () => {
  it("withinDays 以内に失効するロットだけを返す（無期限・期限切れ済みは除外）", () => {
    const soon = lot("1", 100, T0, new Date("2026-09-10T00:00:00+09:00")); // 11日後
    const far = lot("2", 100, T0, new Date("2026-12-01T00:00:00+09:00"));
    const never = lot("3", 100, T0, null);
    const dead = lot("4", 100, T0, new Date("2026-08-01T00:00:00+09:00"));
    expect(expiring({ lots: [soon, far, never, dead], now: NOW, withinDays: 30 })).toEqual([soon]);
  });
});

describe("expiredLots（日次失効バッチの内訳）", () => {
  it("期限切れ × 残ありのロットを expire 相殺量として返す", () => {
    const dead = lot("1", 70, T0, new Date("2026-08-20T00:00:00+09:00"));
    const spent = lot("2", 0, T0, new Date("2026-08-20T00:00:00+09:00"));
    const alive = lot("3", 100, T1, null);
    expect(expiredLots({ lots: [dead, spent, alive], now: NOW })).toEqual([
      { lotId: "1", amount: 70 },
    ]);
  });
});

describe("earnedPoints（金額×率の切り捨て）", () => {
  it("切り捨てで整数のみ", () => {
    expect(earnedPoints({ amount: 12340, ratePercent: 5 })).toBe(617);
    expect(earnedPoints({ amount: 999, ratePercent: 1 })).toBe(9);
    expect(earnedPoints({ amount: 0, ratePercent: 5 })).toBe(0);
  });

  it("小数金額・不正率は RangeError", () => {
    expect(() => earnedPoints({ amount: 100.5, ratePercent: 5 })).toThrow(RangeError);
    expect(() => earnedPoints({ amount: 100, ratePercent: 2.5 })).toThrow(RangeError);
    expect(() => earnedPoints({ amount: 100, ratePercent: 101 })).toThrow(RangeError);
    expect(() => earnedPoints({ amount: -1, ratePercent: 5 })).toThrow(RangeError);
  });
});

describe("clampUse（spec L840 利用上限・下限）", () => {
  it("範囲内はそのまま", () => {
    expect(clampUse({ requested: 300, min: 100, max: 1000, balance: 500 })).toEqual({
      ok: true,
      use: 300,
    });
  });

  it("下限未満 / 上限超過 / 残高不足 / 0以下", () => {
    expect(clampUse({ requested: 50, min: 100, max: null, balance: 500 })).toEqual({
      ok: false,
      reason: "below_min",
    });
    expect(clampUse({ requested: 2000, min: null, max: 1000, balance: 5000 })).toEqual({
      ok: false,
      reason: "above_max",
    });
    expect(clampUse({ requested: 600, min: null, max: null, balance: 500 })).toEqual({
      ok: false,
      reason: "insufficient",
    });
    expect(clampUse({ requested: 0, balance: 500 })).toEqual({ ok: false, reason: "invalid" });
  });
});
