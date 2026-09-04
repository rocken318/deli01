import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  formatShiftTimeRange,
  localDateISO,
  operatingDayISO,
  parseDateISO,
  remainingSlots,
  shiftInstants,
  weekdayIndex,
} from "./shift";

describe("operatingDayISO（営業日 = 15:00〜翌03:00 / 06:00 JST 境界）", () => {
  const jst = (iso: string) => new Date(`${iso}+09:00`);
  it("深夜1時は前暦日（当営業日＝前日15:00開始の回）", () => {
    expect(operatingDayISO(jst("2026-09-11T01:00:00"))).toBe("2026-09-10");
  });
  it("03:00〜05:59 も前営業日（境界は06:00）", () => {
    expect(operatingDayISO(jst("2026-09-11T02:59:00"))).toBe("2026-09-10");
    expect(operatingDayISO(jst("2026-09-11T03:00:00"))).toBe("2026-09-10");
    expect(operatingDayISO(jst("2026-09-11T05:59:00"))).toBe("2026-09-10");
  });
  it("06:00 以降は当暦日（次の営業回＝当日15:00開始）", () => {
    expect(operatingDayISO(jst("2026-09-11T06:00:00"))).toBe("2026-09-11");
    expect(operatingDayISO(jst("2026-09-11T15:30:00"))).toBe("2026-09-11");
    expect(operatingDayISO(jst("2026-09-11T23:00:00"))).toBe("2026-09-11");
  });
  it("UTC 表記でも JST 壁時計で判定（UTC 2026-09-10T16:00Z = JST 09-11 01:00）", () => {
    expect(operatingDayISO(new Date("2026-09-10T16:00:00Z"))).toBe("2026-09-10");
  });
});

describe("shiftInstants（work_date + HH:MM → timestamptz / Asia/Tokyo）", () => {
  it("通常シフト: 2026-08-29 10:00-19:00 JST = 01:00Z-10:00Z", () => {
    const { startAt, endAt } = shiftInstants("2026-08-29", "10:00", "19:00");
    expect(startAt.toISOString()).toBe("2026-08-29T01:00:00.000Z");
    expect(endAt.toISOString()).toBe("2026-08-29T10:00:00.000Z");
  });

  it("日跨ぎシフト: 17:00-01:00 は end が翌日に倒れる", () => {
    const { startAt, endAt } = shiftInstants("2026-08-29", "17:00", "01:00");
    expect(startAt.toISOString()).toBe("2026-08-29T08:00:00.000Z");
    expect(endAt.toISOString()).toBe("2026-08-29T16:00:00.000Z"); // 翌日 01:00 JST
    expect(endAt.getTime()).toBeGreaterThan(startAt.getTime());
  });

  it("開始=終了も日跨ぎ扱い（24時間）で end > start を保つ", () => {
    const { startAt, endAt } = shiftInstants("2026-08-29", "09:00", "09:00");
    expect(endAt.getTime() - startAt.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("不正な日付・時刻は RangeError", () => {
    expect(() => shiftInstants("2026-8-29", "10:00", "19:00")).toThrow(RangeError);
    expect(() => shiftInstants("2026-08-29", "25:00", "19:00")).toThrow(RangeError);
    expect(() => shiftInstants("2026-08-29", "10:00", "19:60")).toThrow(RangeError);
    expect(() => shiftInstants("2026-13-01", "10:00", "19:00")).toThrow(RangeError);
  });
});

describe("formatShiftTimeRange（表示整形 / spec 2-3）", () => {
  it("JST の HH:mm - HH:mm に整形する", () => {
    const { startAt, endAt } = shiftInstants("2026-08-29", "10:00", "19:00");
    expect(formatShiftTimeRange(startAt, endAt)).toBe("10:00 - 19:00");
  });

  it("日跨ぎでも終端はローカル時刻表示（翌 01:00 → 01:00）", () => {
    const { startAt, endAt } = shiftInstants("2026-08-29", "17:00", "01:00");
    expect(formatShiftTimeRange(startAt, endAt)).toBe("17:00 - 01:00");
  });
});

describe("remainingSlots（上限本数の残り / spec 3-3・5-3 手順3）", () => {
  it("上限なし（null）は null（無制限）", () => {
    expect(remainingSlots(null, 0)).toBeNull();
    expect(remainingSlots(null, 10)).toBeNull();
  });

  it("残り = 上限 - 予約済み。マイナスにはならない", () => {
    expect(remainingSlots(3, 0)).toBe(3);
    expect(remainingSlots(3, 1)).toBe(2);
    expect(remainingSlots(3, 3)).toBe(0);
    expect(remainingSlots(3, 5)).toBe(0);
  });

  it("不正値は RangeError", () => {
    expect(() => remainingSlots(0, 0)).toThrow(RangeError);
    expect(() => remainingSlots(3, -1)).toThrow(RangeError);
    expect(() => remainingSlots(2.5, 0)).toThrow(RangeError);
  });
});

describe("日付ユーティリティ（Asia/Tokyo 基準）", () => {
  it("localDateISO: UTC 15:30 は JST の翌日", () => {
    expect(localDateISO(new Date("2026-08-29T15:30:00Z"))).toBe("2026-08-30");
    expect(localDateISO(new Date("2026-08-29T14:30:00Z"))).toBe("2026-08-29");
  });

  it("weekdayIndex: 2026-08-29 は土曜（6）、2026-08-30 は日曜（0）", () => {
    expect(weekdayIndex("2026-08-29")).toBe(6);
    expect(weekdayIndex("2026-08-30")).toBe(0);
    expect(weekdayIndex("2026-08-31")).toBe(1);
  });

  it("addDaysISO: 月跨ぎ・年跨ぎ", () => {
    expect(addDaysISO("2026-08-30", 2)).toBe("2026-09-01");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysISO("2026-08-29", 0)).toBe("2026-08-29");
  });

  it("parseDateISO: 正常値はそのまま、不正値は null", () => {
    expect(parseDateISO("2026-08-29")).toBe("2026-08-29");
    expect(parseDateISO("2026-8-29")).toBeNull();
    expect(parseDateISO("abc")).toBeNull();
    expect(parseDateISO(undefined)).toBeNull();
    expect(parseDateISO(null)).toBeNull();
  });
});
