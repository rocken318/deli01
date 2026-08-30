import { describe, expect, it } from "vitest";
import {
  deferredRevenue,
  pointLiability,
  revenueBreakdown,
  settlement,
  ticketAllocation,
  ticketRedeemAmount,
} from "./ledger";

/**
 * フェーズ17 会計純関数の最小テスト（網羅は qa が後続で拡張）。
 * 検証観点: spec L856（独立行・合算しない）・L846-849（ポイント会計連動）・
 * L857（前受金）・受入 L1092（端数配分）・11-6（突合）。
 */

describe("revenueBreakdown（spec L856: 独立行で計上・合算しない）", () => {
  it("course/option/nomination/transport/midnight が独立行になる", () => {
    const lines = revenueBreakdown({
      coursePrice: 12000,
      options: [
        { optionId: "opt-1", price: 2000 },
        { optionId: "opt-2", price: 1000 },
      ],
      nominationFee: 1000,
      transportFee: 1000,
      midnightSurcharge: 3000,
    });
    expect(lines).toEqual([
      { lineType: "course", amount: 12000 },
      { lineType: "option", amount: 2000, optionId: "opt-1" },
      { lineType: "option", amount: 1000, optionId: "opt-2" },
      { lineType: "nomination", amount: 1000 },
      { lineType: "transport", amount: 1000 },
      { lineType: "midnight", amount: 3000 },
    ]);
    // 合計は保たれる（合算行は無い）
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBe(20000);
  });

  it("0円の構成要素は行にしない（徒歩=交通費0・深夜外）", () => {
    const lines = revenueBreakdown({
      coursePrice: 10000,
      options: [],
      nominationFee: 0,
      transportFee: 0,
      midnightSurcharge: 0,
    });
    expect(lines).toEqual([{ lineType: "course", amount: 10000 }]);
  });

  it("ポイント利用はマイナスの point_use 行（spec L847・受入 L1104）", () => {
    const lines = revenueBreakdown({
      coursePrice: 10000,
      options: [],
      nominationFee: 0,
      transportFee: 0,
      midnightSurcharge: 0,
      pointsUsed: 500,
    });
    expect(lines).toContainEqual({ lineType: "point_use", amount: -500 });
  });

  it("回数券消化は course の代わりに ticket_redeem（配分額の振替 / spec L857）", () => {
    const lines = revenueBreakdown({
      coursePrice: 12000,
      options: [],
      nominationFee: 1000,
      transportFee: 0,
      midnightSurcharge: 0,
      ticketRedeemAmount: 3333,
    });
    expect(lines.map((l) => l.lineType)).toEqual(["ticket_redeem", "nomination"]);
    expect(lines[0]?.amount).toBe(3333); // 券面配分額であって定価12,000ではない
  });

  it("小数は RangeError（金額は整数円のみ）", () => {
    expect(() =>
      revenueBreakdown({
        coursePrice: 100.5,
        options: [],
        nominationFee: 0,
        transportFee: 0,
        midnightSurcharge: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("ticketAllocation / ticketRedeemAmount（受入 L1092: 端数配分）", () => {
  it("10,000円3回券は 3,333 / 3,333 / 3,334", () => {
    expect(ticketAllocation({ totalAmount: 10000, count: 3 })).toEqual([
      3333, 3333, 3334,
    ]);
  });

  it("配分の合計は常に券面総額", () => {
    for (const [total, count] of [
      [10000, 3],
      [9999, 7],
      [30000, 10],
      [1, 3],
    ] as const) {
      const alloc = ticketAllocation({ totalAmount: total, count });
      expect(alloc.reduce((s, a) => s + a, 0)).toBe(total);
      expect(alloc).toHaveLength(count);
    }
  });

  it("n回目の振替額が配分に一致する", () => {
    expect(
      ticketRedeemAmount({ totalAmount: 10000, count: 3, redeemedSoFar: 0 }),
    ).toBe(3333);
    expect(
      ticketRedeemAmount({ totalAmount: 10000, count: 3, redeemedSoFar: 2 }),
    ).toBe(3334);
  });

  it("消化しきったロットへの振替は RangeError", () => {
    expect(() =>
      ticketRedeemAmount({ totalAmount: 10000, count: 3, redeemedSoFar: 3 }),
    ).toThrow(RangeError);
  });
});

describe("deferredRevenue（前受金 = 回数券残 / spec L857）", () => {
  it("発行→2回消化で残回数・前受金残高が正しく出る", () => {
    const entries = [
      { count: 3, amount: 10000 }, // purchase
      { count: -1, amount: -3333 }, // redeem 1
      { count: -1, amount: -3333 }, // redeem 2
    ];
    expect(deferredRevenue(entries)).toEqual({
      remainingCount: 1,
      deferredAmount: 3334,
    });
  });

  it("逆仕訳で残回数が戻る（受入 L1091）", () => {
    const entries = [
      { count: 3, amount: 10000 },
      { count: -1, amount: -3333 },
      { count: 1, amount: 3333 }, // reverse
    ];
    expect(deferredRevenue(entries)).toEqual({
      remainingCount: 3,
      deferredAmount: 10000,
    });
  });
});

describe("pointLiability（引当 = 未使用ポイント / spec L846・L849）", () => {
  it("付与−利用−失効が内訳つきで出る", () => {
    const entries = [
      { type: "earn", points: 1000 },
      { type: "use", points: -300 },
      { type: "expire", points: -100 },
      { type: "adjust", points: 50 },
    ] as const;
    expect(pointLiability(entries)).toEqual({
      earned: 1000,
      used: 300,
      expired: 100,
      adjusted: 50,
      liability: 650,
    });
  });

  it("空なら全て0", () => {
    expect(pointLiability([]).liability).toBe(0);
  });
});

describe("settlement（spec 11-6: 売上 − バック − 経費 = 粗利）", () => {
  it("粗利が正しく出る", () => {
    expect(
      settlement({ revenue: 100000, payout: 45000, expenses: 12000 }),
    ).toEqual({
      revenue: 100000,
      payout: 45000,
      expenses: 12000,
      grossProfit: 43000,
    });
  });

  it("バック未実装（フェーズ18前）は payout=0 で動く", () => {
    expect(settlement({ revenue: 50000, payout: 0, expenses: 8000 }).grossProfit).toBe(
      42000,
    );
  });

  it("小数は RangeError", () => {
    expect(() => settlement({ revenue: 0.5, payout: 0, expenses: 0 })).toThrow(
      RangeError,
    );
  });
});
