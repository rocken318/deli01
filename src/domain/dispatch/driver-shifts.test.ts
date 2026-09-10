import { describe, it, expect } from "vitest";
import { mondayOf, dowOfDate, parseDayTime, formatDayTime } from "./driver-shifts";

describe("mondayOf", () => {
  it("水曜(2026-09-16)の週開始は月曜 2026-09-14", () => {
    expect(mondayOf("2026-09-16")).toBe("2026-09-14");
  });
  it("月曜はその日自身", () => {
    expect(mondayOf("2026-09-14")).toBe("2026-09-14");
  });
  it("日曜(2026-09-20)の週開始は 2026-09-14", () => {
    expect(mondayOf("2026-09-20")).toBe("2026-09-14");
  });
});

describe("dowOfDate（0=月..6=日）", () => {
  it("月曜=0", () => expect(dowOfDate("2026-09-14")).toBe(0));
  it("日曜=6", () => expect(dowOfDate("2026-09-20")).toBe(6));
});

describe("parseDayTime / formatDayTime（25時超え）", () => {
  it("'27:00' → 1620", () => expect(parseDayTime("27:00")).toBe(1620));
  it("'9:30' → 570", () => expect(parseDayTime("9:30")).toBe(570));
  it("不正は null", () => {
    expect(parseDayTime("black")).toBeNull();
    expect(parseDayTime("12:60")).toBeNull();
    expect(parseDayTime("")).toBeNull();
  });
  it("1620 → '27:00'（ゼロ埋め）", () => expect(formatDayTime(1620)).toBe("27:00"));
  it("570 → '09:30'", () => expect(formatDayTime(570)).toBe("09:30"));
});
