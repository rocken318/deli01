import { describe, expect, it } from "vitest";
import { compareShiftVsAttendance } from "./diff";

const at = (h: number, m = 0) => new Date(2026, 8, 1, h, m, 0);
const NOW = at(20).getTime();

describe("compareShiftVsAttendance", () => {
  it("予定あり・打刻なし・予定開始を過ぎている → 未打刻", () => {
    expect(compareShiftVsAttendance({ startAt: at(18), endAt: at(2) }, null, NOW).label).toBe(
      "未打刻",
    );
  });

  it("予定なし・実績なし → 対象外（予定通りと区別）", () => {
    expect(compareShiftVsAttendance(null, null, NOW).label).toBe("対象外");
  });

  it("予定なし・出勤打刻あり → 予定外出勤", () => {
    expect(
      compareShiftVsAttendance(null, { clockInAt: at(19), clockOutAt: null }, NOW).label,
    ).toBe("予定外出勤");
  });

  it("予定開始より遅い出勤 → 遅刻（分も返す）", () => {
    const r = compareShiftVsAttendance(
      { startAt: at(18), endAt: at(23) },
      { clockInAt: at(18, 20), clockOutAt: null },
      NOW,
    );
    expect(r.label).toBe("遅刻");
    expect(r.lateMin).toBe(20);
  });

  it("予定終了より早い退勤 → 早退（分も返す）", () => {
    const r = compareShiftVsAttendance(
      { startAt: at(18), endAt: at(23) },
      { clockInAt: at(18), clockOutAt: at(22, 30) },
      NOW,
    );
    expect(r.label).toBe("早退");
    expect(r.earlyMin).toBe(30);
  });

  it("退勤済で早退でない → 退勤済", () => {
    expect(
      compareShiftVsAttendance(
        { startAt: at(18), endAt: at(22) },
        { clockInAt: at(18), clockOutAt: at(22) },
        NOW,
      ).label,
    ).toBe("退勤済");
  });

  it("予定通り出勤・稼働中 → 予定通り", () => {
    expect(
      compareShiftVsAttendance(
        { startAt: at(18), endAt: at(23) },
        { clockInAt: at(18), clockOutAt: null },
        NOW,
      ).label,
    ).toBe("予定通り");
  });

  it("予定あり・打刻なし・まだ予定開始前 → 予定通り", () => {
    const before = at(17).getTime();
    expect(
      compareShiftVsAttendance({ startAt: at(18), endAt: at(23) }, null, before).label,
    ).toBe("予定通り");
  });
});
