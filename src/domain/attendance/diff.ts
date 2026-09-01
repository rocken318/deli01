//
// 予定(shift)と実績(attendance)の差分ラベルを導出する純関数。
// 用途は「稼働の可視化」（spec 3-5）。遅刻/早退は事実の表示であって
// 制裁・時間管理のためではない（spec 16章）。
export type DiffLabel =
  | "予定通り"
  | "未打刻"
  | "遅刻"
  | "早退"
  | "予定外出勤"
  | "退勤済";

type Plan = { startAt: Date; endAt: Date } | null;
type Actual = { clockInAt: Date | null; clockOutAt: Date | null } | null;

const MIN = 60_000;

export function compareShiftVsAttendance(
  plan: Plan,
  actual: Actual,
  nowMs: number,
): { label: DiffLabel; lateMin?: number; earlyMin?: number } {
  const inAt = actual?.clockInAt ?? null;
  const outAt = actual?.clockOutAt ?? null;

  // 予定なし
  if (!plan) {
    if (inAt) return { label: "予定外出勤" };
    return { label: "予定通り" }; // 予定も実績も無い＝対象外扱い
  }

  // 予定あり・未出勤
  if (!inAt) {
    // 予定開始を過ぎても打刻が無い → 未打刻。まだ開始前なら予定通り。
    return nowMs > plan.startAt.getTime() ? { label: "未打刻" } : { label: "予定通り" };
  }

  // 退勤済
  if (outAt) {
    const earlyMs = plan.endAt.getTime() - outAt.getTime();
    if (earlyMs > 0) return { label: "早退", earlyMin: Math.round(earlyMs / MIN) };
    return { label: "退勤済" };
  }

  // 稼働中：遅刻判定
  const lateMs = inAt.getTime() - plan.startAt.getTime();
  if (lateMs > 0) return { label: "遅刻", lateMin: Math.round(lateMs / MIN) };
  return { label: "予定通り" };
}
