/**
 * 出勤の一括登録で使う「期間×曜日 → 該当日付」列挙（純関数）。
 * "use server" ファイルから分離する（Server Actions は async 必須のため、
 * 同期の純関数はドメイン層に置く）。
 */

export const MAX_BULK_DAYS = 100;

/**
 * rangeStart..rangeEnd（両端含む）で weekdays（0=日〜6=土）に該当する
 * YYYY-MM-DD を列挙する。カレンダー日での増分＝タイムゾーン非依存。
 * 終了 < 開始、または該当日が上限を超える場合は throw する。
 */
export function enumerateShiftDates(
  rangeStart: string,
  rangeEnd: string,
  weekdays: number[],
): string[] {
  const [ys, ms, ds] = rangeStart.split("-").map(Number);
  const [ye, me, de] = rangeEnd.split("-").map(Number);
  const start = new Date(ys!, ms! - 1, ds!);
  const end = new Date(ye!, me! - 1, de!);
  if (end < start) throw new Error("終了日は開始日以降にしてください");
  const wd = new Set(weekdays);
  const out: string[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (wd.has(d.getDay())) {
      out.push(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate(),
        ).padStart(2, "0")}`,
      );
      if (out.length > MAX_BULK_DAYS) {
        throw new Error(`一度に登録できるのは${MAX_BULK_DAYS}日までです。期間を狭めてください`);
      }
    }
  }
  return out;
}
