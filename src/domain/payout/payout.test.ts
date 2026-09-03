import { describe, expect, it } from "vitest";
import {
  buildReservationPayout,
  computePayoutLine,
  resolveRate,
  settlePayoutPeriod,
} from "./index";
import type { PayoutRate, ResolvedRate } from "./index";

/**
 * フェーズ18 報酬純粋関数（spec 11章・15章）。
 * - L1096: 個別レート > ランク別 > 既定 の優先順位
 * - L1094: 適用開始日でその日に有効なレートを選ぶ（過去不変の土台）
 * - L1095: 回数券消化の施術でもバックが発生する
 * - L1098: calc_note に計算根拠（レート・元金額・計算式）が残る
 * - L919: noshow は交通費のみ / L920: 値引の基礎は設定（既定は値引前）
 */

const T1 = "11111111-0000-4000-8000-000000000001"; // therapist
const T2 = "11111111-0000-4000-8000-000000000002"; // 別 therapist
const RANK = "bbbbbbbb-0000-4000-9000-000000000003";
const COURSE = "22222222-0000-4000-8000-000000000001";
const OPT_A = "33333333-0000-4000-8000-000000000001";

let seq = 0;
function rate(partial: Partial<PayoutRate>): PayoutRate {
  seq += 1;
  return {
    id: `44444444-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    therapistId: null,
    rankId: null,
    targetType: "course",
    targetId: null,
    calcType: "rate",
    value: 50,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...partial,
  };
}

describe("resolveRate（spec L894・受入 L1096: 個別 > ランク別 > 既定）", () => {
  const rates: PayoutRate[] = [
    rate({ value: 50 }), // 既定 50%
    rate({ rankId: RANK, value: 60 }), // ランク別 60%
    rate({ therapistId: T1, value: 65 }), // 個別 65%
  ];

  it("個別レートが最優先される", () => {
    const r = resolveRate({
      rates,
      therapistId: T1,
      rankId: RANK,
      targetType: "course",
      targetId: COURSE,
      businessDate: "2026-06-01",
    });
    expect(r?.scope).toBe("individual");
    expect(r?.rate.value).toBe(65);
  });

  it("個別がなければランク別、ランクもなければ既定", () => {
    const byRank = resolveRate({
      rates,
      therapistId: T2,
      rankId: RANK,
      targetType: "course",
      targetId: COURSE,
      businessDate: "2026-06-01",
    });
    expect(byRank?.scope).toBe("rank");
    expect(byRank?.rate.value).toBe(60);

    const byDefault = resolveRate({
      rates,
      therapistId: T2,
      rankId: null,
      targetType: "course",
      targetId: COURSE,
      businessDate: "2026-06-01",
    });
    expect(byDefault?.scope).toBe("default");
    expect(byDefault?.rate.value).toBe(50);
  });

  it("他人の個別レートは当たらない", () => {
    const r = resolveRate({
      rates: [rate({ therapistId: T1, value: 65 })],
      therapistId: T2,
      rankId: null,
      targetType: "course",
      targetId: COURSE,
      businessDate: "2026-06-01",
    });
    expect(r).toBeNull();
  });

  it("適用開始日: businessDate 時点で有効なレートを選ぶ（受入 L1094 の土台）", () => {
    const history: PayoutRate[] = [
      rate({ value: 50, effectiveFrom: "2026-01-01" }),
      rate({ value: 55, effectiveFrom: "2026-07-01" }), // 改定
    ];
    const before = resolveRate({
      rates: history,
      therapistId: T1,
      rankId: null,
      targetType: "course",
      targetId: COURSE,
      businessDate: "2026-06-30",
    });
    expect(before?.rate.value).toBe(50);
    const after = resolveRate({
      rates: history,
      therapistId: T1,
      rankId: null,
      targetType: "course",
      targetId: COURSE,
      businessDate: "2026-07-01",
    });
    expect(after?.rate.value).toBe(55);
  });

  it("effective_to は半開区間（その日を含まない）", () => {
    const capped = [
      rate({ value: 50, effectiveFrom: "2026-01-01", effectiveTo: "2026-07-01" }),
    ];
    expect(
      resolveRate({
        rates: capped,
        therapistId: T1,
        rankId: null,
        targetType: "course",
        targetId: COURSE,
        businessDate: "2026-06-30",
      })?.rate.value,
    ).toBe(50);
    expect(
      resolveRate({
        rates: capped,
        therapistId: T1,
        rankId: null,
        targetType: "course",
        targetId: COURSE,
        businessDate: "2026-07-01",
      }),
    ).toBeNull();
  });

  it("具体 target_id が汎用（null）より優先される", () => {
    const r = resolveRate({
      rates: [
        rate({ value: 50, targetId: null }),
        rate({ value: 70, targetId: COURSE }),
      ],
      therapistId: T1,
      rankId: null,
      targetType: "course",
      targetId: COURSE,
      businessDate: "2026-06-01",
    });
    expect(r?.rate.value).toBe(70);
  });

  it("target_type が違うレートは当たらない", () => {
    const r = resolveRate({
      rates: [rate({ targetType: "nomination", value: 100 })],
      therapistId: T1,
      rankId: null,
      targetType: "course",
      targetId: COURSE,
      businessDate: "2026-06-01",
    });
    expect(r).toBeNull();
  });

  it("率が小数・範囲外なら RangeError（整数厳守）", () => {
    expect(() =>
      resolveRate({
        rates: [rate({ value: 45.5 })],
        therapistId: T1,
        rankId: null,
        targetType: "course",
        targetId: COURSE,
        businessDate: "2026-06-01",
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveRate({
        rates: [rate({ value: 120 })],
        therapistId: T1,
        rankId: null,
        targetType: "course",
        targetId: COURSE,
        businessDate: "2026-06-01",
      }),
    ).toThrow(RangeError);
  });
});

describe("computePayoutLine（spec L913・受入 L1098: calc_note に根拠が残る）", () => {
  const resolved45: ResolvedRate = {
    rate: rate({ value: 45, effectiveFrom: "2026-04-01" }),
    scope: "rank",
  };

  it("率: floor(基礎 × % / 100)。spec の例 12,000円 × 45% = 5,400円", () => {
    const { amount, calcNote } = computePayoutLine({
      rate: resolved45,
      baseAmount: 12000,
      businessDate: "2026-06-01",
      label: "90分コース",
    });
    expect(amount).toBe(5400);
    // L1098: レートID・適用日・元金額・計算式がそのまま残る
    expect(calcNote.rateId).toBe(resolved45.rate.id);
    expect(calcNote.effectiveFrom).toBe("2026-04-01");
    expect(calcNote.baseAmount).toBe(12000);
    expect(calcNote.rateValue).toBe(45);
    expect(calcNote.formula).toBe("12000円 × 45% = 5400円");
    expect(calcNote.scope).toBe("rank");
    expect(calcNote.label).toBe("90分コース");
    expect(calcNote.businessDate).toBe("2026-06-01");
  });

  it("端数は floor（17,000円 × 55% = 9,350円 / 2,500円 × 55% = 1,375円）", () => {
    expect(
      computePayoutLine({
        rate: { rate: rate({ value: 55 }), scope: "default" },
        baseAmount: 17000,
      }).amount,
    ).toBe(9350);
    expect(
      computePayoutLine({
        rate: { rate: rate({ value: 33 }), scope: "default" },
        baseAmount: 1000,
      }).amount,
    ).toBe(330);
  });

  it("固定: 円そのまま（指名料の全額バック等）", () => {
    const { amount, calcNote } = computePayoutLine({
      rate: {
        rate: rate({ targetType: "nomination", calcType: "fixed", value: 1000 }),
        scope: "default",
      },
      baseAmount: 1000,
    });
    expect(amount).toBe(1000);
    expect(calcNote.formula).toBe("固定 1000円");
  });

  it("基礎が小数・負なら RangeError", () => {
    expect(() =>
      computePayoutLine({ rate: resolved45, baseAmount: 100.5 }),
    ).toThrow(RangeError);
    expect(() =>
      computePayoutLine({ rate: resolved45, baseAmount: -1 }),
    ).toThrow(RangeError);
  });
});

describe("buildReservationPayout（spec 11-2・11-3）", () => {
  // 既定レート一式（spec 18-4 レギュラー相当）
  const rates: PayoutRate[] = [
    rate({ targetType: "course", value: 55 }),
    rate({ targetType: "option", value: 50 }),
    rate({ targetType: "nomination", value: 100 }),
    rate({ targetType: "transport", value: 100 }),
    rate({ targetType: "late_night", value: 50 }),
    rate({ targetType: "cancel_fee", value: 50 }),
  ];

  const baseReservation = {
    therapistId: T1,
    rankId: null,
    businessDate: "2026-06-01",
    outcome: "done" as const,
    courseId: COURSE,
    coursePrice: 17000,
    courseLabel: "90分コース",
    options: [{ optionId: OPT_A, price: 2500, label: "ヘッドケア" }],
    nominationFee: 1000,
    transportFee: 1000,
    lateNightFee: 0,
  };

  it("done: コース/オプション/指名が独立行で立つ（交通費はバックに入れない）", () => {
    const { lines, unresolved } = buildReservationPayout({
      reservation: baseReservation,
      rates,
    });
    expect(unresolved).toEqual([]);
    const byCat = Object.fromEntries(lines.map((l) => [l.category, l.amount]));
    expect(byCat["course"]).toBe(9350); // 17000×55%
    expect(byCat["option"]).toBe(1250); // 2500×50%
    expect(byCat["nomination"]).toBe(1000); // 100%
    // 交通費は店の経費（発注者決定 2026-09-04）。バック行は立てない
    expect(byCat["transport"]).toBeUndefined();
    expect(byCat["late_night"]).toBeUndefined(); // 深夜加算なし → 行なし
    expect(lines.find((l) => l.category === "option")?.optionId).toBe(OPT_A);
  });

  it("★回数券消化でもバックが発生する（spec L917・受入 L1095）", () => {
    const { lines } = buildReservationPayout({
      reservation: { ...baseReservation, paidByTicket: true },
      rates,
    });
    const course = lines.find((l) => l.category === "course");
    expect(course?.amount).toBe(9350); // 現金の有無で変わらない
    expect(course?.calcNote.base?.paidByTicket).toBe(true);
  });

  it("noshow: バックなし（交通費は本人に入れない / 発注者決定 2026-09-04）", () => {
    const { lines } = buildReservationPayout({
      reservation: { ...baseReservation, outcome: "noshow" },
      rates,
    });
    expect(lines).toEqual([]);
  });

  it("cancelled: キャンセル料 × cancel_fee レート（spec L918 既定は一部）", () => {
    const { lines } = buildReservationPayout({
      reservation: {
        ...baseReservation,
        outcome: "cancelled",
        cancelFeeAmount: 8500,
        transportFee: 0,
      },
      rates,
    });
    expect(lines.map((l) => l.category)).toEqual(["cancel_fee"]);
    expect(lines[0]?.amount).toBe(4250); // 8500×50%
  });

  it("値引の基礎: 既定は値引前（spec L920）、設定で値引後にできる", () => {
    const withDiscount = { ...baseReservation, discountAmount: 2000 };
    const before = buildReservationPayout({ reservation: withDiscount, rates });
    expect(before.lines.find((l) => l.category === "course")?.amount).toBe(9350);

    const after = buildReservationPayout({
      reservation: withDiscount,
      rates,
      settings: {
        discountBase: "after",
        includePointUseInBase: true,
        includeTicketRedeemInBase: true,
      },
    });
    const courseLine = after.lines.find((l) => l.category === "course");
    expect(courseLine?.amount).toBe(8250); // (17000−2000)×55%
    expect(courseLine?.calcNote.baseAmount).toBe(15000);
    expect(courseLine?.calcNote.base?.discountBase).toBe("after");
  });

  it("深夜加算がある場合は late_night 行が立つ", () => {
    const { lines } = buildReservationPayout({
      reservation: { ...baseReservation, lateNightFee: 3000 },
      rates,
    });
    expect(lines.find((l) => l.category === "late_night")?.amount).toBe(1500);
  });

  it("レート未設定の対象は unresolved として返る（黙って握り潰さない）", () => {
    const { lines, unresolved } = buildReservationPayout({
      reservation: baseReservation,
      rates: [rate({ targetType: "course", value: 55 })], // course のみ設定
    });
    expect(lines.map((l) => l.category)).toEqual(["course"]);
    // 交通費はそもそも payout 対象にしないため unresolved にも現れない
    expect(unresolved.map((u) => u.targetType).sort()).toEqual([
      "nomination",
      "option",
    ]);
  });

  it("料金 0 の構成要素は行にしない（指名なし・交通費 0）", () => {
    const { lines, unresolved } = buildReservationPayout({
      reservation: {
        ...baseReservation,
        options: [],
        nominationFee: 0,
        transportFee: 0,
      },
      rates,
    });
    expect(lines.map((l) => l.category)).toEqual(["course"]);
    expect(unresolved).toEqual([]);
  });
});

describe("settlePayoutPeriod（spec 11-4）", () => {
  it("gross = Σ lines（逆仕訳込み）、net = gross − 控除", () => {
    const s = settlePayoutPeriod({
      lines: [{ amount: 9350 }, { amount: 1000 }, { amount: -1000 }],
      deductions: [{ amount: 500 }, { amount: 300 }],
    });
    expect(s.gross).toBe(9350);
    expect(s.deductions).toBe(800);
    expect(s.net).toBe(8550);
    expect(s.lineCount).toBe(3);
  });

  it("控除が 0 以下なら RangeError（控除は正の円で持つ）", () => {
    expect(() =>
      settlePayoutPeriod({ lines: [], deductions: [{ amount: 0 }] }),
    ).toThrow(RangeError);
  });

  it("小数は RangeError", () => {
    expect(() => settlePayoutPeriod({ lines: [{ amount: 10.5 }] })).toThrow(
      RangeError,
    );
  });
});
