import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/**
 * 出勤予定（shifts）の純粋関数（フェーズ8 / spec 3-3・2-3）。
 *
 * DB にも Next.js にも依存しない。タイムゾーンは常に Asia/Tokyo（呼び出し側で
 * 上書き可能だが、全処理 Asia/Tokyo が既定 / spec 1-2）。
 * 日時は Date（timestamptz の写像）で受け渡し、文字列で計算しない。
 */

/** 全処理の既定タイムゾーン（spec 1-2） */
export const APP_TIME_ZONE = "Asia/Tokyo";

const HHMM_RE = /^([0-1]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** shifts.start_at / end_at の組（timestamptz の写像） */
export interface ShiftInstants {
  startAt: Date;
  endAt: Date;
}

/**
 * 営業日（work_date）+ ローカル時刻 "HH:MM" から start_at / end_at を組み立てる。
 * 終了 <= 開始 のときは日跨ぎシフト（例 17:00〜01:00）として終了を翌日に倒す。
 * shifts の CHECK (end_at > start_at) と同じ不変条件をここで満たす。
 */
export function shiftInstants(
  workDate: string,
  startHHMM: string,
  endHHMM: string,
  timeZone: string = APP_TIME_ZONE,
): ShiftInstants {
  if (!DATE_RE.test(workDate)) {
    throw new RangeError(`workDate は "YYYY-MM-DD" であること: ${workDate}`);
  }
  if (!HHMM_RE.test(startHHMM) || !HHMM_RE.test(endHHMM)) {
    throw new RangeError(`時刻は "HH:MM"（00:00〜23:59）であること: ${startHHMM} / ${endHHMM}`);
  }
  const startAt = fromZonedTime(`${workDate}T${startHHMM}:00`, timeZone);
  let endAt = fromZonedTime(`${workDate}T${endHHMM}:00`, timeZone);
  if (endAt.getTime() <= startAt.getTime()) {
    // 日跨ぎ（spec 5-3「日跨ぎの予約」と同様、シフトも 23:30 開始〜翌 02:00 等を許す）
    endAt = addDays(endAt, 1);
  }
  return { startAt, endAt };
}

/**
 * 出勤時間帯の表示用整形（例 "10:00 - 19:00"）。
 * 出勤表（/schedule）は「時間帯」を出すだけで、この帯がそのまま予約できるとは
 * 限らない（spec 2-3。確定枠はフェーズ9-10 で住所前提の再計算）。
 * 表記はロケール非依存の等幅向け文字のみ（公開側の直書き日本語禁止 / spec 13-1）。
 */
export function formatShiftTimeRange(
  startAt: Date,
  endAt: Date,
  timeZone: string = APP_TIME_ZONE,
): string {
  const start = formatInTimeZone(startAt, timeZone, "HH:mm");
  const end = formatInTimeZone(endAt, timeZone, "HH:mm");
  return `${start} - ${end}`;
}

/**
 * 上限本数の残り（spec 3-3「1日の最大施術本数」/ 5-3 手順3）。
 * - maxBookings が null = 上限なし → null を返す（無制限）
 * - 上限あり → max(0, 上限 - 予約済み本数)。0 ならその日はもう受けられない
 * フェーズ9 の空き枠エンジンは remaining === 0 のとき空を返す。
 */
export function remainingSlots(
  maxBookings: number | null,
  bookedCount: number,
): number | null {
  if (!Number.isInteger(bookedCount) || bookedCount < 0) {
    throw new RangeError(`bookedCount は 0 以上の整数であること: ${bookedCount}`);
  }
  if (maxBookings === null) return null;
  if (!Number.isInteger(maxBookings) || maxBookings <= 0) {
    throw new RangeError(`maxBookings は正の整数か null であること: ${maxBookings}`);
  }
  return Math.max(0, maxBookings - bookedCount);
}

/**
 * その日の Asia/Tokyo ローカル日付（"YYYY-MM-DD"）。
 * 出勤表の既定表示日・日付タブの生成に使う（サーバの OS タイムゾーンに依存しない）。
 */
export function localDateISO(at: Date, timeZone: string = APP_TIME_ZONE): string {
  return formatInTimeZone(at, timeZone, "yyyy-MM-dd");
}

/**
 * now の「営業日」（work_date 基準の "YYYY-MM-DD"）。
 *
 * 営業は 15:00〜翌03:00（＝27:00）想定。深夜帯（00:00〜05:59）は前日の営業回に属する
 * ので、**06:00 JST を日の境界**にする（03:00〜06:00 の待機時間も前営業日側）。
 * 例: 深夜1時なら当営業日＝前暦日（前日15:00開始の枠）。空き枠の前方探索の起点に使い、
 * 「現在時刻を跨いだ営業日」を正しく当日として扱う（03:00 を過ぎ 06:00 以降で翌営業日へ）。
 */
export function operatingDayISO(at: Date, timeZone: string = APP_TIME_ZONE): string {
  const stamp = formatInTimeZone(at, timeZone, "yyyy-MM-dd'T'HH");
  const dateISO = stamp.slice(0, 10);
  const hour = Number(stamp.slice(11, 13));
  if (hour >= 6) return dateISO;
  return addDaysISO(dateISO, -1, timeZone);
}

/**
 * "YYYY-MM-DD" の曜日番号（0=日曜〜6=土曜、Asia/Tokyo 基準）。
 * 曜日の表示文字は CMS（ui_labels.schedule_weekdays）から引く。ここは番号だけ返す。
 */
export function weekdayIndex(dateISO: string, timeZone: string = APP_TIME_ZONE): number {
  if (!DATE_RE.test(dateISO)) {
    throw new RangeError(`dateISO は "YYYY-MM-DD" であること: ${dateISO}`);
  }
  const at = fromZonedTime(`${dateISO}T12:00:00`, timeZone);
  // date-fns "i" = ISO 曜日（1=月〜7=日）→ 0=日〜6=土 へ写す
  const iso = Number(formatInTimeZone(at, timeZone, "i"));
  return iso % 7;
}

/**
 * dateISO から days 日進めた "YYYY-MM-DD"（Asia/Tokyo 基準）。日付タブの列挙に使う。
 */
export function addDaysISO(
  dateISO: string,
  days: number,
  timeZone: string = APP_TIME_ZONE,
): string {
  if (!DATE_RE.test(dateISO)) {
    throw new RangeError(`dateISO は "YYYY-MM-DD" であること: ${dateISO}`);
  }
  if (!Number.isInteger(days)) {
    throw new RangeError(`days は整数であること: ${days}`);
  }
  const at = fromZonedTime(`${dateISO}T12:00:00`, timeZone);
  return formatInTimeZone(addDays(at, days), timeZone, "yyyy-MM-dd");
}

/** 公開出勤表が受け取る日付パラメータの検証（不正なら null） */
export function parseDateISO(value: string | undefined | null): string | null {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  return value;
}

/**
 * "YYYY-MM-DD" が実在する暦日か（2026-02-31 等を弾く）。
 * Postgres の date キャスト前に細工 URL を弾くため、公開側の読取層で使う。
 */
export function isRealDateISO(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
