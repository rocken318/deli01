import { describe, expect, it } from "vitest";
import { totalPrice, totalServiceMinutes } from "./pricing";

/**
 * spec 3-4「duration_min が空き枠計算に効く」/ 5-3「L = コース + オプション合計」と
 * 金額の整数（円）規約（CLAUDE.md 禁止事項）を純粋関数レベルで固定する。
 * 空き枠アルゴリズムへの L の組み込みはフェーズ9、金額の予約への反映はフェーズ11。
 */

describe("totalServiceMinutes（L = コース時間 + オプション duration_min 合計 / spec 5-3）", () => {
  it("スタンダード90 + 延長30(+30) + ヘッドケア(+15) = 135分", () => {
    expect(
      totalServiceMinutes(90, [{ durationMin: 30 }, { durationMin: 15 }]),
    ).toBe(135);
  });

  it("オプションなしはコース時間そのまま", () => {
    expect(totalServiceMinutes(60, [])).toBe(60);
  });

  it("duration_min=0 のオプション（アロマ等）は時間を変えない（spec 18-2）", () => {
    expect(totalServiceMinutes(60, [{ durationMin: 0 }])).toBe(60);
  });

  it("結果は常に整数（分）", () => {
    expect(Number.isInteger(totalServiceMinutes(90, [{ durationMin: 30 }]))).toBe(true);
  });

  it("コース時間 0 以下・小数、オプションの負数・小数は RangeError", () => {
    expect(() => totalServiceMinutes(0, [])).toThrow(RangeError);
    expect(() => totalServiceMinutes(90.5, [])).toThrow(RangeError);
    expect(() => totalServiceMinutes(90, [{ durationMin: -15 }])).toThrow(RangeError);
    expect(() => totalServiceMinutes(90, [{ durationMin: 7.5 }])).toThrow(RangeError);
  });
});

describe("totalPrice（すべて整数の円 / spec 18章・CLAUDE.md）", () => {
  it("スタンダード¥17,000 + 延長30¥6,000 + ヘッドケア¥2,500 = ¥25,500", () => {
    expect(
      totalPrice({
        coursePrice: 17000,
        selectedOptions: [{ price: 6000 }, { price: 2500 }],
      }),
    ).toBe(25500);
  });

  it("指名料・交通費も合算される（spec 18-3）", () => {
    expect(
      totalPrice({
        coursePrice: 12000,
        selectedOptions: [],
        nominationFee: 1000,
        transportFee: 1000,
      }),
    ).toBe(14000);
  });

  it("指名料・交通費の省略は 0 扱い（フリー・徒歩圏）", () => {
    expect(totalPrice({ coursePrice: 12000, selectedOptions: [] })).toBe(12000);
  });

  it("結果は常に整数（円）", () => {
    const total = totalPrice({
      coursePrice: 27000,
      selectedOptions: [{ price: 2000 }],
      nominationFee: 3000,
    });
    expect(Number.isInteger(total)).toBe(true);
  });

  it("小数の金額は RangeError（金額に小数を使わない）", () => {
    expect(() => totalPrice({ coursePrice: 17000.5, selectedOptions: [] })).toThrow(RangeError);
    expect(() =>
      totalPrice({ coursePrice: 17000, selectedOptions: [{ price: 100.1 }] }),
    ).toThrow(RangeError);
    expect(() =>
      totalPrice({ coursePrice: 17000, selectedOptions: [], nominationFee: 999.9 }),
    ).toThrow(RangeError);
  });

  it("負の金額は RangeError（割引は別の仕組みで行う / spec 10章）", () => {
    expect(() => totalPrice({ coursePrice: -1, selectedOptions: [] })).toThrow(RangeError);
    expect(() =>
      totalPrice({ coursePrice: 17000, selectedOptions: [{ price: -500 }] }),
    ).toThrow(RangeError);
  });
});
