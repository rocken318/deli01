import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/**
 * 日次会計（G）の「営業日」範囲を算出する純関数。
 *
 * 発注者確認（2026-09-02）: 計上日は「営業日（受注した日）」。深夜（日跨ぎ）分は
 * 前の営業日に寄せる。そこで **06:00 JST を日の境界**にする（00:00–05:59 開始の
 * 予約は前営業日に計上）。売上/バックは timestamptz 範囲（06:00 シフト）で、経費は
 * 日付のみ（spent_on）なので暦日範囲で集計する（運営者が営業日を選んで入力）。
 *
 * ⚠ 本ビュー限定の定義。/admin/payouts の締めは従来どおり暦日 business_date 基準。
 */

const TZ = "Asia/Tokyo";
/** 営業日の開始時刻（JST 時）。00:00–05:59 開始の予約は前営業日に寄る。 */
export const BUSINESS_DAY_START_HOUR = 6;

export type BooksPeriod = "day" | "week" | "month";

export interface BusinessDayRange {
  period: BooksPeriod;
  /** 表示ラベル（例: 2026-09-02 / 2026-09-01〜09-07 / 2026-09） */
  label: string;
  /** 売上/バック/支払方法用の timestamptz 範囲（06:00 シフト・半開 [from, to)） */
  from: Date;
  to: Date;
  /** 経費（spent_on 日付）用の暦日範囲（YYYY-MM-DD・半開 [fromDate, toDate)） */
  fromDate: string;
  toDate: string;
  /** 正規化した基準日（day=その日 / week=週頭の月曜 / month=1日） */
  anchorDate: string;
}

/** YYYY-MM-DD に n 日足す（JST 暦日・時刻を持たない純計算）。 */
function addDaysISO(dateISO: string, n: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const base = Date.UTC(y!, m! - 1, d!);
  const next = new Date(base + n * 86_400_000);
  return next.toISOString().slice(0, 10);
}

/** dateISO の JST 曜日（0=日〜6=土）。 */
function dowJST(dateISO: string): number {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** 営業日 D の開始インスタント（D 06:00 JST を UTC の Date で）。 */
function dayStartInstant(dateISO: string): Date {
  return fromZonedTime(`${dateISO}T0${BUSINESS_DAY_START_HOUR}:00:00`, TZ);
}

/**
 * 指定日 + 期間から営業日範囲を返す。
 * @param dateISO 基準日（YYYY-MM-DD, JST 暦日）
 * @param period  "day" | "week"（月曜起点）| "month"
 */
export function businessDayRange(dateISO: string, period: BooksPeriod): BusinessDayRange {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    throw new Error(`invalid dateISO: ${dateISO}`);
  }

  if (period === "day") {
    const toDate = addDaysISO(dateISO, 1);
    return {
      period,
      label: dateISO,
      from: dayStartInstant(dateISO),
      to: dayStartInstant(toDate),
      fromDate: dateISO,
      toDate,
      anchorDate: dateISO,
    };
  }

  if (period === "week") {
    // 月曜起点（dow: 月=1）。dateISO を含む週の月曜を求める。
    const dow = dowJST(dateISO);
    const backToMonday = (dow + 6) % 7; // 月=0, 日=6
    const monday = addDaysISO(dateISO, -backToMonday);
    const nextMonday = addDaysISO(monday, 7);
    return {
      period,
      label: `${monday}〜${addDaysISO(monday, 6)}`,
      from: dayStartInstant(monday),
      to: dayStartInstant(nextMonday),
      fromDate: monday,
      toDate: nextMonday,
      anchorDate: monday,
    };
  }

  // month
  const [y, m] = dateISO.split("-").map(Number);
  const first = `${dateISO.slice(0, 7)}-01`;
  const nextFirst = m === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  return {
    period,
    label: dateISO.slice(0, 7),
    from: dayStartInstant(first),
    to: dayStartInstant(nextFirst),
    fromDate: first,
    toDate: nextFirst,
    anchorDate: first,
  };
}

/** JST の「今日」を YYYY-MM-DD で（営業日基準の初期値に使う。境界前でも当日でよい）。 */
export function todayISOInTokyo(nowMs: number): string {
  return formatInTimeZone(new Date(nowMs), TZ, "yyyy-MM-dd");
}
