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
 * フェーズ17 会計純関数の網羅追加テスト（qa 担当）。
 * ledger.test.ts（architect 作・16件）と重複させず、未検査の境界条件・
 * エラーパス・複数オプション・符号規約を追加する。
 */

// ---------------------------------------------------------------------------
// revenueBreakdown 追加ケース
// ---------------------------------------------------------------------------

describe("revenueBreakdown 追加ケース", () => {
  it("オプションが複数のとき optionId 別に独立行が立つ（合算しない）", () => {
    const lines = revenueBreakdown({
      coursePrice: 10000,
      options: [
        { optionId: "opt-A", price: 1000 },
        { optionId: "opt-B", price: 2000 },
        { optionId: "opt-C", price: 500 },
      ],
      nominationFee: 0,
      transportFee: 0,
      midnightSurcharge: 0,
    });
    const optLines = lines.filter((l) => l.lineType === "option");
    expect(optLines).toHaveLength(3);
    expect(optLines.map((l) => l.optionId)).toEqual(["opt-A", "opt-B", "opt-C"]);
    expect(optLines.map((l) => l.amount)).toEqual([1000, 2000, 500]);
    // optionId が必ず付く
    for (const l of optLines) {
      expect(l.optionId).toBeTruthy();
    }
  });

  it("オプションが0円なら行に入らない", () => {
    const lines = revenueBreakdown({
      coursePrice: 10000,
      options: [{ optionId: "opt-X", price: 0 }],
      nominationFee: 0,
      transportFee: 0,
      midnightSurcharge: 0,
    });
    expect(lines.every((l) => l.lineType !== "option")).toBe(true);
  });

  it("全構成要素が0円のとき行が1本も立たない", () => {
    const lines = revenueBreakdown({
      coursePrice: 0,
      options: [],
      nominationFee: 0,
      transportFee: 0,
      midnightSurcharge: 0,
    });
    expect(lines).toHaveLength(0);
  });

  it("coursePrice が負のとき RangeError", () => {
    expect(() =>
      revenueBreakdown({
        coursePrice: -1,
        options: [],
        nominationFee: 0,
        transportFee: 0,
        midnightSurcharge: 0,
      }),
    ).toThrow(RangeError);
  });

  it("nominationFee が負のとき RangeError", () => {
    expect(() =>
      revenueBreakdown({
        coursePrice: 0,
        options: [],
        nominationFee: -1,
        transportFee: 0,
        midnightSurcharge: 0,
      }),
    ).toThrow(RangeError);
  });

  it("transportFee が負のとき RangeError", () => {
    expect(() =>
      revenueBreakdown({
        coursePrice: 0,
        options: [],
        nominationFee: 0,
        transportFee: -1,
        midnightSurcharge: 0,
      }),
    ).toThrow(RangeError);
  });

  it("midnightSurcharge が負のとき RangeError", () => {
    expect(() =>
      revenueBreakdown({
        coursePrice: 0,
        options: [],
        nominationFee: 0,
        transportFee: 0,
        midnightSurcharge: -1,
      }),
    ).toThrow(RangeError);
  });

  it("ticketRedeemAmount が0のとき course も ticket_redeem も立たない（零額振替の回数券消化）", () => {
    // 1円未満に切り捨てられた配分が0になるケースのエッジ
    const lines = revenueBreakdown({
      coursePrice: 10000,
      options: [],
      nominationFee: 0,
      transportFee: 0,
      midnightSurcharge: 0,
      ticketRedeemAmount: 0,
    });
    expect(lines.every((l) => l.lineType !== "course")).toBe(true);
    expect(lines.every((l) => l.lineType !== "ticket_redeem")).toBe(true);
  });

  it("ticketRedeemAmount が負のとき RangeError", () => {
    expect(() =>
      revenueBreakdown({
        coursePrice: 10000,
        options: [],
        nominationFee: 0,
        transportFee: 0,
        midnightSurcharge: 0,
        ticketRedeemAmount: -1,
      }),
    ).toThrow(RangeError);
  });

  it("pointsUsed が0のとき point_use 行は立たない", () => {
    const lines = revenueBreakdown({
      coursePrice: 10000,
      options: [],
      nominationFee: 0,
      transportFee: 0,
      midnightSurcharge: 0,
      pointsUsed: 0,
    });
    expect(lines.every((l) => l.lineType !== "point_use")).toBe(true);
  });

  it("pointsUsed が負のとき RangeError", () => {
    expect(() =>
      revenueBreakdown({
        coursePrice: 10000,
        options: [],
        nominationFee: 0,
        transportFee: 0,
        midnightSurcharge: 0,
        pointsUsed: -1,
      }),
    ).toThrow(RangeError);
  });

  it("ポイント利用と回数券消化が同時のとき ticket_redeem + point_use（課題はセットで）", () => {
    const lines = revenueBreakdown({
      coursePrice: 12000,
      options: [],
      nominationFee: 500,
      transportFee: 0,
      midnightSurcharge: 0,
      ticketRedeemAmount: 3333,
      pointsUsed: 1000,
    });
    const types = lines.map((l) => l.lineType);
    expect(types).toContain("ticket_redeem");
    expect(types).toContain("nomination");
    expect(types).toContain("point_use");
    expect(types).not.toContain("course");
    const pu = lines.find((l) => l.lineType === "point_use");
    expect(pu?.amount).toBe(-1000);
  });

  it("全5種類（course/option/nomination/transport/midnight）の行順序が仕様どおり", () => {
    // course → option → nomination → transport → midnight の順
    const lines = revenueBreakdown({
      coursePrice: 10000,
      options: [{ optionId: "opt-1", price: 2000 }],
      nominationFee: 1000,
      transportFee: 500,
      midnightSurcharge: 3000,
    });
    const types = lines.map((l) => l.lineType);
    expect(types.indexOf("course")).toBeLessThan(types.indexOf("option"));
    expect(types.indexOf("option")).toBeLessThan(types.indexOf("nomination"));
    expect(types.indexOf("nomination")).toBeLessThan(types.indexOf("transport"));
    expect(types.indexOf("transport")).toBeLessThan(types.indexOf("midnight"));
  });

  it("小数の nominationFee は RangeError（金額は整数円のみ）", () => {
    expect(() =>
      revenueBreakdown({
        coursePrice: 10000,
        options: [],
        nominationFee: 0.5,
        transportFee: 0,
        midnightSurcharge: 0,
      }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// ticketAllocation 追加ケース
// ---------------------------------------------------------------------------

describe("ticketAllocation 追加ケース", () => {
  it("1回券（count=1）は全額が1要素", () => {
    expect(ticketAllocation({ totalAmount: 10000, count: 1 })).toEqual([10000]);
  });

  it("totalAmount=0 は全て0の配列", () => {
    expect(ticketAllocation({ totalAmount: 0, count: 3 })).toEqual([0, 0, 0]);
  });

  it("count=0 は RangeError", () => {
    expect(() => ticketAllocation({ totalAmount: 10000, count: 0 })).toThrow(RangeError);
  });

  it("count が負のとき RangeError", () => {
    expect(() => ticketAllocation({ totalAmount: 10000, count: -1 })).toThrow(RangeError);
  });

  it("totalAmount が負のとき RangeError", () => {
    expect(() => ticketAllocation({ totalAmount: -1, count: 3 })).toThrow(RangeError);
  });

  it("1円を3回で割ったとき端数は最後の回に寄る", () => {
    // 1/3=0.33... → [0, 0, 1]
    expect(ticketAllocation({ totalAmount: 1, count: 3 })).toEqual([0, 0, 1]);
  });

  it("9999を7回で割ったとき合計は必ず9999", () => {
    const alloc = ticketAllocation({ totalAmount: 9999, count: 7 });
    expect(alloc.reduce((s, a) => s + a, 0)).toBe(9999);
    expect(alloc).toHaveLength(7);
  });

  it("小数の totalAmount は RangeError（金額は整数円のみ）", () => {
    expect(() => ticketAllocation({ totalAmount: 100.1, count: 3 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// ticketRedeemAmount 追加ケース
// ---------------------------------------------------------------------------

describe("ticketRedeemAmount 追加ケース", () => {
  it("1回目=3333, 2回目=3333, 3回目=3334（端数は最後）", () => {
    for (const [n, expected] of [
      [0, 3333],
      [1, 3333],
      [2, 3334],
    ] as const) {
      expect(
        ticketRedeemAmount({ totalAmount: 10000, count: 3, redeemedSoFar: n }),
      ).toBe(expected);
    }
  });

  it("redeemedSoFar < 0 は RangeError", () => {
    expect(() =>
      ticketRedeemAmount({ totalAmount: 10000, count: 3, redeemedSoFar: -1 }),
    ).toThrow(RangeError);
  });

  it("redeemedSoFar = count は RangeError（全消化済み）", () => {
    expect(() =>
      ticketRedeemAmount({ totalAmount: 10000, count: 3, redeemedSoFar: 3 }),
    ).toThrow(RangeError);
  });

  it("1回券の0回目は全額", () => {
    expect(
      ticketRedeemAmount({ totalAmount: 5000, count: 1, redeemedSoFar: 0 }),
    ).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// deferredRevenue 追加ケース
// ---------------------------------------------------------------------------

describe("deferredRevenue 追加ケース", () => {
  it("空配列のとき残回数・前受金ともに0", () => {
    expect(deferredRevenue([])).toEqual({ remainingCount: 0, deferredAmount: 0 });
  });

  it("全回消化したとき残回数・前受金ともに0", () => {
    const entries = [
      { count: 2, amount: 6000 }, // purchase
      { count: -1, amount: -3000 }, // redeem 1
      { count: -1, amount: -3000 }, // redeem 2
    ];
    expect(deferredRevenue(entries)).toEqual({ remainingCount: 0, deferredAmount: 0 });
  });

  it("expire 行（失効）で残回数と前受金が減る", () => {
    const entries = [
      { count: 3, amount: 10000 },
      { count: -2, amount: -6667 }, // expire 残2回を失効
    ];
    const result = deferredRevenue(entries);
    expect(result.remainingCount).toBe(1);
    expect(result.deferredAmount).toBe(3333);
  });

  it("adjust 行（±）で残高が変動する", () => {
    const entries = [
      { count: 3, amount: 10000 },
      { count: 1, amount: 1000 }, // 追加調整
    ];
    expect(deferredRevenue(entries)).toEqual({ remainingCount: 4, deferredAmount: 11000 });
  });

  it("複数ロットの合算が正しい（ロットを分けても sum が取れる）", () => {
    const entries = [
      { count: 3, amount: 9000 }, // ロット1
      { count: 5, amount: 15000 }, // ロット2
      { count: -1, amount: -3000 }, // redeem from lot1
    ];
    expect(deferredRevenue(entries)).toEqual({ remainingCount: 7, deferredAmount: 21000 });
  });
});

// ---------------------------------------------------------------------------
// pointLiability 追加ケース
// ---------------------------------------------------------------------------

describe("pointLiability 追加ケース", () => {
  it("reverse 行は adjusted に加算される", () => {
    const result = pointLiability([
      { type: "earn", points: 1000 },
      { type: "use", points: -300 },
      { type: "reverse", points: 200 }, // use 行の逆仕訳
    ]);
    expect(result.adjusted).toBe(200);
    expect(result.liability).toBe(900); // 1000 - 300 + 200
  });

  it("全て use・expire で使い切ったとき liability=0", () => {
    const result = pointLiability([
      { type: "earn", points: 500 },
      { type: "use", points: -300 },
      { type: "expire", points: -200 },
    ]);
    expect(result.liability).toBe(0);
    expect(result.earned).toBe(500);
    expect(result.used).toBe(300);
    expect(result.expired).toBe(200);
    expect(result.adjusted).toBe(0);
  });

  it("複数の earn・use を合算して内訳が正しい", () => {
    const result = pointLiability([
      { type: "earn", points: 1000 },
      { type: "earn", points: 500 },
      { type: "use", points: -200 },
      { type: "use", points: -100 },
    ]);
    expect(result.earned).toBe(1500);
    expect(result.used).toBe(300);
    expect(result.liability).toBe(1200);
  });

  it("引当残のみ負になる恒等式（earned - used - expired + adjusted = liability）", () => {
    const entries: ReadonlyArray<{ type: "earn" | "use" | "expire" | "adjust" | "reverse"; points: number }> = [
      { type: "earn", points: 2000 },
      { type: "use", points: -500 },
      { type: "expire", points: -300 },
      { type: "adjust", points: -100 },
      { type: "reverse", points: 50 },
    ];
    const r = pointLiability(entries);
    expect(r.liability).toBe(r.earned - r.used - r.expired + r.adjusted);
  });
});

// ---------------------------------------------------------------------------
// settlement 追加ケース
// ---------------------------------------------------------------------------

describe("settlement 追加ケース", () => {
  it("経費が売上を上回るとき grossProfit が負になる", () => {
    const s = settlement({ revenue: 10000, payout: 0, expenses: 15000 });
    expect(s.grossProfit).toBe(-5000);
  });

  it("全て0のとき grossProfit=0", () => {
    expect(settlement({ revenue: 0, payout: 0, expenses: 0 }).grossProfit).toBe(0);
  });

  it("payout が売上を超えるとき grossProfit が負になる", () => {
    const s = settlement({ revenue: 50000, payout: 60000, expenses: 0 });
    expect(s.grossProfit).toBe(-10000);
  });

  it("全ての引数が整数でなければ RangeError", () => {
    expect(() => settlement({ revenue: 100, payout: 0.1, expenses: 0 })).toThrow(RangeError);
    expect(() => settlement({ revenue: 100, payout: 0, expenses: 0.5 })).toThrow(RangeError);
  });

  it("結果のオブジェクトに revenue/payout/expenses/grossProfit が揃う", () => {
    const s = settlement({ revenue: 100000, payout: 30000, expenses: 20000 });
    expect(s).toMatchObject({ revenue: 100000, payout: 30000, expenses: 20000, grossProfit: 50000 });
  });
});
