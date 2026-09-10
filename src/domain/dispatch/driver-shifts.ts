/**
 * ドライバー週次シフトの純関数（設計 4.3）。
 * 週=月曜始まり。時刻は当日0:00からの分（25時超え可）。
 * 日付は "YYYY-MM-DD"（Asia/Tokyo の暦日）を UTC 正午基準で扱い、DST の無い JST で安全。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toUtcNoon(dateISO: string): Date {
  // JST は DST 無し。正午を使い日跨ぎ丸め誤差を避ける。
  return new Date(`${dateISO}T12:00:00Z`);
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** dateISO を含む週（月曜始まり）の月曜を返す。 */
export function mondayOf(dateISO: string): string {
  if (!DATE_RE.test(dateISO)) throw new RangeError(`bad date: ${dateISO}`);
  const d = toUtcNoon(dateISO);
  const jsDow = d.getUTCDay(); // 0=日..6=土
  const backToMon = (jsDow + 6) % 7; // 月曜まで戻す日数
  d.setUTCDate(d.getUTCDate() - backToMon);
  return fmt(d);
}

/** 0=月 .. 6=日 */
export function dowOfDate(dateISO: string): number {
  if (!DATE_RE.test(dateISO)) throw new RangeError(`bad date: ${dateISO}`);
  const jsDow = toUtcNoon(dateISO).getUTCDay();
  return (jsDow + 6) % 7;
}

/** "HH:MM"（時は0..47）→ 当日0:00からの分。不正は null。 */
export function parseDayTime(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 47 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 分 → "HH:MM"（時は2桁ゼロ埋め・25時超え可）。 */
export function formatDayTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
