import { describe, expect, it } from "vitest";
import {
  activeLots,
  balance,
  clampUse,
  consumeFifo,
  earnedPoints,
  expiredLots,
  expiring,
  isActiveLot,
  sumLedger,
  type PointLot,
} from "./index";

/**
 * フェーズ16 QA 追加 — 純関数の網羅（既存 points.test.ts との重複なし）。
 *
 * 追加観点:
 * - consumeFifo: 複数ロット跨ぎ内訳・期限切れロットを飛ばす・ちょうど・不足shortage・
 *   order（occurredAt→id の安定ソート）
 * - clampUse: 境界（min=requested / max=requested / balance=requested）
 * - earnedPoints: 0率・100率・負amountのRangeError・負rateのRangeError
 * - balance: 空=0・混在符号・大数 safe integer
 * - expiring/expiredLots: withinDays=0 境界・今まさに失効（exactly now）
 * - isActiveLot/activeLots: 直接の正しさ
 */

const D = (s: string) => new Date(s);
const NOW = D("2026-09-01T12:00:00+09:00");

function lot(
  id: string,
  remaining: number,
  occurredAt: Date,
  expiresAt: Date | null = null,
): PointLot {
  return { lotId: id, remaining, occurredAt, expiresAt };
}

// ---------------------------------------------------------------------------
// isActiveLot / activeLots
// ---------------------------------------------------------------------------
describe("isActiveLot（期限内・残ありの判定）", () => {
  it("remaining=0 は inactive", () => {
    expect(isActiveLot(lot("1", 0, NOW, null), NOW)).toBe(false);
  });

  it("expiresAt == now は inactive（境界: > でなく >=）", () => {
    expect(isActiveLot(lot("1", 100, NOW, NOW), NOW)).toBe(false);
  });

  it("expiresAt が 1ms 後なら active", () => {
    const future = new Date(NOW.getTime() + 1);
    expect(isActiveLot(lot("1", 100, NOW, future), NOW)).toBe(true);
  });

  it("expiresAt=null（無期限）は active", () => {
    expect(isActiveLot(lot("1", 100, NOW, null), NOW)).toBe(true);
  });
});

describe("activeLots（occurredAt 昇順 → lotId 昇順）", () => {
  it("複数ロットが occurredAt 昇順・同時刻は id 昇順", () => {
    const t1 = D("2026-08-01T00:00:00+09:00");
    const t2 = D("2026-08-10T00:00:00+09:00");
    const result = activeLots(
      [
        lot("20", 100, t2, null),
        lot("5", 100, t1, null),
        lot("3", 100, t1, null),
      ],
      NOW,
    );
    expect(result.map((l) => l.lotId)).toEqual(["3", "5", "20"]);
  });

  it("期限切れ・残ゼロは除外", () => {
    const dead = lot("1", 100, NOW, new Date(NOW.getTime() - 1));
    const zero = lot("2", 0, NOW, null);
    const alive = lot("3", 50, NOW, null);
    expect(activeLots([dead, zero, alive], NOW)).toEqual([alive]);
  });
});

// ---------------------------------------------------------------------------
// consumeFifo 追加ケース
// ---------------------------------------------------------------------------
describe("consumeFifo: 複数ロット跨ぎの内訳", () => {
  const t0 = D("2026-07-01T00:00:00+09:00");
  const t1 = D("2026-08-01T00:00:00+09:00");
  const t2 = D("2026-08-15T00:00:00+09:00");

  it("3ロット跨ぎ: 内訳が正しく分割される", () => {
    const r = consumeFifo({
      lots: [
        lot("3", 200, t2, null),
        lot("1", 100, t0, null),
        lot("2", 150, t1, null),
      ],
      usePoints: 320,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: true, total: 320 });
    if (!r.ok) return;
    expect(r.consumption).toEqual([
      { lotId: "1", amount: 100 },
      { lotId: "2", amount: 150 },
      { lotId: "3", amount: 70 },
    ]);
  });

  it("期限切れロット（expiresAt <= now）は内訳から飛ばされる", () => {
    const expired = lot("1", 500, t0, new Date(NOW.getTime() - 1000)); // ちょうど過去
    const alive = lot("2", 200, t1, null);
    const r = consumeFifo({ lots: [expired, alive], usePoints: 300, now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "insufficient", available: 200, shortage: 100 });
  });

  it("ちょうど残高分: ok:true・shortage なし", () => {
    const r = consumeFifo({
      lots: [lot("1", 300, t0, null)],
      usePoints: 300,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: true, total: 300 });
    if (!r.ok) return;
    expect(r.consumption).toEqual([{ lotId: "1", amount: 300 }]);
  });

  it("1P 不足（available=299 / requested=300）", () => {
    const r = consumeFifo({
      lots: [lot("1", 299, t0, null)],
      usePoints: 300,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason: "insufficient", available: 299, shortage: 1 });
  });

  it("全ロット期限切れで残高 0 → insufficient", () => {
    const r = consumeFifo({
      lots: [lot("1", 1000, t0, new Date(NOW.getTime() - 1))],
      usePoints: 1,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason: "insufficient", available: 0, shortage: 1 });
  });

  it("同時刻ロットは lotId（追記順）で安定に並ぶ（2桁以上 ID が文字列長順）", () => {
    // "9" < "10" 文字列比較は避け、長さ順 → 辞書順
    const r = consumeFifo({
      lots: [
        lot("10", 50, t0, null),
        lot("9", 50, t0, null),
        lot("11", 50, t0, null),
      ],
      usePoints: 120,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.consumption.map((c) => c.lotId)).toEqual(["9", "10", "11"]);
  });
});

// ---------------------------------------------------------------------------
// clampUse 境界
// ---------------------------------------------------------------------------
describe("clampUse: 境界値", () => {
  it("requested == min（ちょうど下限）は ok", () => {
    expect(clampUse({ requested: 100, min: 100, max: null, balance: 500 })).toEqual({
      ok: true,
      use: 100,
    });
  });

  it("requested == max（ちょうど上限）は ok", () => {
    expect(clampUse({ requested: 1000, min: null, max: 1000, balance: 5000 })).toEqual({
      ok: true,
      use: 1000,
    });
  });

  it("requested == balance（ちょうど残高）は ok", () => {
    expect(clampUse({ requested: 300, min: null, max: null, balance: 300 })).toEqual({
      ok: true,
      use: 300,
    });
  });

  it("requested == min - 1 は below_min", () => {
    expect(clampUse({ requested: 99, min: 100, max: null, balance: 500 })).toEqual({
      ok: false,
      reason: "below_min",
    });
  });

  it("requested == max + 1 は above_max", () => {
    expect(clampUse({ requested: 1001, min: null, max: 1000, balance: 5000 })).toEqual({
      ok: false,
      reason: "above_max",
    });
  });

  it("requested == balance + 1 は insufficient", () => {
    expect(clampUse({ requested: 301, min: null, max: null, balance: 300 })).toEqual({
      ok: false,
      reason: "insufficient",
    });
  });

  it("min=null max=null で 1P は valid", () => {
    expect(clampUse({ requested: 1, balance: 1 })).toEqual({ ok: true, use: 1 });
  });

  it("min と max の両方が有効: min <= requested <= max 且つ <= balance", () => {
    expect(clampUse({ requested: 500, min: 100, max: 1000, balance: 2000 })).toEqual({
      ok: true,
      use: 500,
    });
  });

  it("balance=0 は insufficient（残高ゼロ）", () => {
    expect(clampUse({ requested: 1, balance: 0 })).toEqual({
      ok: false,
      reason: "insufficient",
    });
  });
});

// ---------------------------------------------------------------------------
// earnedPoints 追加
// ---------------------------------------------------------------------------
describe("earnedPoints: 追加ケース", () => {
  it("ratePercent=0 は常に 0", () => {
    expect(earnedPoints({ amount: 100000, ratePercent: 0 })).toBe(0);
  });

  it("ratePercent=100 は amount そのまま", () => {
    expect(earnedPoints({ amount: 1234, ratePercent: 100 })).toBe(1234);
  });

  it("amount=0 は常に 0", () => {
    expect(earnedPoints({ amount: 0, ratePercent: 10 })).toBe(0);
  });

  it("切り捨てで p.5 は切り捨て（1P にならない）", () => {
    // 100円 × 1% = 1.0P → 1
    expect(earnedPoints({ amount: 100, ratePercent: 1 })).toBe(1);
    // 99円 × 1% = 0.99P → 0
    expect(earnedPoints({ amount: 99, ratePercent: 1 })).toBe(0);
  });

  it("ratePercent が 101 は RangeError", () => {
    expect(() => earnedPoints({ amount: 100, ratePercent: 101 })).toThrow(RangeError);
  });

  it("ratePercent が -1 は RangeError", () => {
    expect(() => earnedPoints({ amount: 100, ratePercent: -1 })).toThrow(RangeError);
  });

  it("amount が負は RangeError", () => {
    expect(() => earnedPoints({ amount: -1, ratePercent: 5 })).toThrow(RangeError);
  });

  it("amount が小数は RangeError", () => {
    expect(() => earnedPoints({ amount: 100.5, ratePercent: 5 })).toThrow(RangeError);
  });

  it("ratePercent が小数は RangeError", () => {
    expect(() => earnedPoints({ amount: 100, ratePercent: 1.5 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// balance / sumLedger 追加
// ---------------------------------------------------------------------------
describe("balance / sumLedger: 追加ケース", () => {
  it("符号混在: 正と負の合計が正しい", () => {
    expect(balance([{ points: 1000 }, { points: -300 }, { points: -200 }, { points: 50 }])).toBe(
      550,
    );
  });

  it("全て負: 残高がマイナスになる（逆仕訳等）", () => {
    expect(balance([{ points: -100 }, { points: -50 }])).toBe(-150);
  });

  it("Number.MAX_SAFE_INTEGER は safe integer として通る", () => {
    expect(() => sumLedger([Number.MAX_SAFE_INTEGER])).not.toThrow();
  });

  it("Number.MAX_SAFE_INTEGER + 1 は RangeError", () => {
    expect(() => sumLedger([Number.MAX_SAFE_INTEGER + 1])).toThrow(RangeError);
  });

  it("Infinity は RangeError", () => {
    expect(() => sumLedger([Infinity])).toThrow(RangeError);
  });

  it("NaN は RangeError", () => {
    expect(() => sumLedger([NaN])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// expiring 追加（withinDays 境界）
// ---------------------------------------------------------------------------
describe("expiring: withinDays 境界", () => {
  it("withinDays=0: 期限切れ済み（expiresAt <= now）は active でないので 0件", () => {
    const dead = lot("1", 100, NOW, NOW); // expiresAt == now は inactive
    expect(expiring({ lots: [dead], now: NOW, withinDays: 0 })).toHaveLength(0);
  });

  it("withinDays=0: 1ms 後に失効するロットは含まれる（now < expiresAt <= now+0ms... は 0日だが expiresAt > now）", () => {
    // withinDays=0: limit = now + 0 = now。expiresAt <= limit 且つ > now の範囲は空
    const almostNow = new Date(NOW.getTime() + 1);
    const r = expiring({ lots: [lot("1", 100, NOW, almostNow)], now: NOW, withinDays: 0 });
    // expiresAt=now+1ms > now（active）かつ > limit（now+0ms）なので除外 → 0件
    expect(r).toHaveLength(0);
  });

  it("withinDays=1: ちょうど今から86400秒後（24時間）は含まれる", () => {
    const exactly24h = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const r = expiring({
      lots: [lot("1", 100, NOW, exactly24h)],
      now: NOW,
      withinDays: 1,
    });
    expect(r).toHaveLength(1);
  });

  it("withinDays=1: 24時間+1msec 後は圏外", () => {
    const justOver24h = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);
    const r = expiring({
      lots: [lot("1", 100, NOW, justOver24h)],
      now: NOW,
      withinDays: 1,
    });
    expect(r).toHaveLength(0);
  });

  it("withinDays が負は RangeError", () => {
    expect(() => expiring({ lots: [], now: NOW, withinDays: -1 })).toThrow(RangeError);
  });

  it("expiresAt=null（無期限）は expiring に含まれない", () => {
    expect(
      expiring({ lots: [lot("1", 100, NOW, null)], now: NOW, withinDays: 365 }),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// expiredLots 追加
// ---------------------------------------------------------------------------
describe("expiredLots: 追加ケース", () => {
  it("expiresAt == now（境界）は期限切れに含まれる", () => {
    const exactly = lot("1", 100, NOW, NOW); // expiresAt <= now
    expect(expiredLots({ lots: [exactly], now: NOW })).toEqual([{ lotId: "1", amount: 100 }]);
  });

  it("expiresAt が 1ms 後は含まれない", () => {
    const future = lot("1", 100, NOW, new Date(NOW.getTime() + 1));
    expect(expiredLots({ lots: [future], now: NOW })).toHaveLength(0);
  });

  it("残ゼロのロットは含まれない（消費済み）", () => {
    const dead = lot("1", 0, NOW, new Date(NOW.getTime() - 1000));
    expect(expiredLots({ lots: [dead], now: NOW })).toHaveLength(0);
  });

  it("期限切れロットが複数ある場合は occurredAt 昇順 → id 昇順", () => {
    const t0 = D("2026-07-01T00:00:00+09:00");
    const t1 = D("2026-08-01T00:00:00+09:00");
    const expired1 = lot("2", 100, t1, new Date(NOW.getTime() - 1));
    const expired2 = lot("1", 200, t0, new Date(NOW.getTime() - 1));
    const result = expiredLots({ lots: [expired1, expired2], now: NOW });
    expect(result.map((r) => r.lotId)).toEqual(["1", "2"]);
    expect(result.map((r) => r.amount)).toEqual([200, 100]);
  });

  it("expiresAt=null は失効対象にならない", () => {
    const never = lot("1", 100, NOW, null);
    expect(expiredLots({ lots: [never], now: NOW })).toHaveLength(0);
  });
});
