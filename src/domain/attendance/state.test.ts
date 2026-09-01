import { describe, expect, it } from "vitest";
import { nextPunchAction, deriveAttendanceState } from "./state";

const D = (h: number) => new Date(2026, 8, 1, h, 0, 0);

describe("nextPunchAction", () => {
  it("行なし → clock_in", () => {
    expect(nextPunchAction(null)).toBe("clock_in");
  });
  it("出勤済・未退勤 → clock_out", () => {
    expect(nextPunchAction({ clockInAt: D(18), clockOutAt: null })).toBe("clock_out");
  });
  it("退勤済 → none", () => {
    expect(nextPunchAction({ clockInAt: D(18), clockOutAt: D(2) })).toBe("none");
  });
});

describe("deriveAttendanceState", () => {
  it("null → off", () => expect(deriveAttendanceState(null)).toBe("off"));
  it("出勤のみ → working", () =>
    expect(deriveAttendanceState({ clockInAt: D(18), clockOutAt: null })).toBe("working"));
  it("退勤済 → done", () =>
    expect(deriveAttendanceState({ clockInAt: D(18), clockOutAt: D(2) })).toBe("done"));
});
