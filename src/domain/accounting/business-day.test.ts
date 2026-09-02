import { describe, expect, it } from "vitest";
import { businessDayRange } from "./business-day";

/** UTC ISO を JST の "yyyy-MM-dd HH:mm" で見て検証する。 */
const jst = (d: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);

describe("businessDayRange（G 日次会計・06:00 JST 境界）", () => {
  it("日: [D 06:00, D+1 06:00) JST", () => {
    const r = businessDayRange("2026-09-02", "day");
    expect(r.label).toBe("2026-09-02");
    expect(jst(r.from)).toBe("2026-09-02 06:00");
    expect(jst(r.to)).toBe("2026-09-03 06:00");
    expect(r.fromDate).toBe("2026-09-02");
    expect(r.toDate).toBe("2026-09-03");
  });

  it("日: 深夜 02:00 開始は前営業日の範囲に入る（from < 02:00翌暦日 < to）", () => {
    // 営業日 2026-09-02 の範囲は 09-02 06:00 〜 09-03 06:00。
    // 09-03 02:00 JST の予約はこの範囲内＝前営業日 09-02 に計上される。
    const r = businessDayRange("2026-09-02", "day");
    const lateNight = new Date("2026-09-02T17:00:00Z"); // = 09-03 02:00 JST
    expect(lateNight >= r.from && lateNight < r.to).toBe(true);
  });

  it("週: 月曜起点。水曜を渡すとその週の月曜〜翌月曜", () => {
    // 2026-09-02 は水曜。週頭は 2026-08-31(月)。
    const r = businessDayRange("2026-09-02", "week");
    expect(r.fromDate).toBe("2026-08-31");
    expect(r.toDate).toBe("2026-09-07");
    expect(jst(r.from)).toBe("2026-08-31 06:00");
    expect(jst(r.to)).toBe("2026-09-07 06:00");
    expect(r.label).toBe("2026-08-31〜2026-09-06");
  });

  it("月: [1日 06:00, 翌月1日 06:00)。12月は年跨ぎ", () => {
    const r = businessDayRange("2026-12-15", "month");
    expect(r.fromDate).toBe("2026-12-01");
    expect(r.toDate).toBe("2027-01-01");
    expect(r.label).toBe("2026-12");
    expect(jst(r.from)).toBe("2026-12-01 06:00");
    expect(jst(r.to)).toBe("2027-01-01 06:00");
  });

  it("不正な日付は例外", () => {
    expect(() => businessDayRange("2026/09/02", "day")).toThrow();
  });
});
