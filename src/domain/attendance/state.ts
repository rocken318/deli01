export type AttendanceRow = { clockInAt: Date | null; clockOutAt: Date | null };
export type AttendanceState = "off" | "working" | "done";

/** 次に押すべき打刻。行なし→出勤／出勤済未退勤→退勤／退勤済→なし。 */
export function nextPunchAction(a: AttendanceRow | null): "clock_in" | "clock_out" | "none" {
  if (!a || !a.clockInAt) return "clock_in";
  if (!a.clockOutAt) return "clock_out";
  return "none";
}

/** 案内表が消費する土台。off=未出勤 / working=出勤中 / done=退勤済。 */
export function deriveAttendanceState(a: AttendanceRow | null): AttendanceState {
  if (!a || !a.clockInAt) return "off";
  return a.clockOutAt ? "done" : "working";
}
