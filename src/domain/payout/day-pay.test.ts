import { describe, it, expect } from "vitest";
import { computeDayPay } from "./day-pay";

describe("computeDayPay（雑費=合計×率%・切り捨て）", () => {
  it("15000×10% → 雑費1500・支払13500", () => {
    expect(computeDayPay(15000, 10)).toEqual({ gross: 15000, misc: 1500, pay: 13500 });
  });
  it("32000×10% → 雑費3200・支払28800", () => {
    expect(computeDayPay(32000, 10)).toEqual({ gross: 32000, misc: 3200, pay: 28800 });
  });
  it("端数は切り捨て: 15005×10% → 雑費1500・支払13505", () => {
    expect(computeDayPay(15005, 10)).toEqual({ gross: 15005, misc: 1500, pay: 13505 });
  });
  it("0円は雑費0", () => {
    expect(computeDayPay(0, 10)).toEqual({ gross: 0, misc: 0, pay: 0 });
  });
  it("率0%は雑費0", () => {
    expect(computeDayPay(10000, 0)).toEqual({ gross: 10000, misc: 0, pay: 10000 });
  });
});
