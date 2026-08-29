import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOKING_FEES,
  feeBreakdown,
  midnightSurcharge,
  transportFee,
} from "./fees";

/** Asia/Tokyo の壁時計から UTC Date を作る（+9:00 固定） */
function jst(iso: string): Date {
  return new Date(`${iso}+09:00`);
}

describe("transportFee（spec 18-3）", () => {
  it("徒歩圏は 0 円", () => {
    expect(transportFee("walk")).toBe(0);
  });
  it("車は設定額（既定 1,000 円）", () => {
    expect(transportFee("car")).toBe(1000);
  });
  it("小数の設定は RangeError（金額整数の禁止事項）", () => {
    expect(() =>
      transportFee("car", { ...DEFAULT_BOOKING_FEES, transportCar: 1000.5 }),
    ).toThrow(RangeError);
  });
});

describe("midnightSurcharge（spec 18-3: 24:00〜5:00 開始で +3,000）", () => {
  it("0:00 開始（境界の下端・含む）は加算", () => {
    expect(midnightSurcharge(jst("2026-09-01T00:00:00"))).toBe(3000);
  });
  it("4:59 開始は加算", () => {
    expect(midnightSurcharge(jst("2026-09-01T04:59:00"))).toBe(3000);
  });
  it("5:00 開始（境界の上端・含まない）は加算なし", () => {
    expect(midnightSurcharge(jst("2026-09-01T05:00:00"))).toBe(0);
  });
  it("23:30 開始は加算なし（開始時刻で判定。日跨ぎ終了でも加算しない）", () => {
    expect(midnightSurcharge(jst("2026-09-01T23:30:00"))).toBe(0);
  });
  it("UTC の日付が前日でも Asia/Tokyo の壁時計で判定する", () => {
    // UTC 2026-08-31T15:30Z = JST 2026-09-01T00:30 → 深夜帯
    expect(midnightSurcharge(new Date("2026-08-31T15:30:00Z"))).toBe(3000);
  });
  it("跨ぎ設定（22〜5時）にも対応する", () => {
    const s = { ...DEFAULT_BOOKING_FEES, midnightFromHour: 22, midnightToHour: 5 };
    expect(midnightSurcharge(jst("2026-09-01T23:00:00"), s)).toBe(3000);
    expect(midnightSurcharge(jst("2026-09-01T21:59:00"), s)).toBe(0);
  });
});

describe("feeBreakdown（spec 6章 手順9: 最後まで料金を隠さない合計）", () => {
  it("コース + オプション + 指名料 + 交通費（車）+ 深夜加算", () => {
    const b = feeBreakdown({
      coursePrice: 10000,
      optionPrices: [2000, 1000],
      nominationFee: 1000,
      travelInMode: "car",
      startAt: jst("2026-09-01T01:00:00"),
    });
    expect(b.optionsTotal).toBe(3000);
    expect(b.transportFee).toBe(1000);
    expect(b.midnightSurcharge).toBe(3000);
    expect(b.totalAmount).toBe(10000 + 3000 + 1000 + 1000 + 3000);
  });
  it("徒歩・昼はコース + オプション + 指名料のみ", () => {
    const b = feeBreakdown({
      coursePrice: 8000,
      optionPrices: [],
      nominationFee: 0,
      travelInMode: "walk",
      startAt: jst("2026-09-01T14:00:00"),
    });
    expect(b.totalAmount).toBe(8000);
  });
  it("小数の金額は RangeError", () => {
    expect(() =>
      feeBreakdown({
        coursePrice: 8000.1,
        optionPrices: [],
        nominationFee: 0,
        travelInMode: "walk",
        startAt: jst("2026-09-01T14:00:00"),
      }),
    ).toThrow(RangeError);
  });
});
