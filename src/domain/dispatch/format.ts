import { formatInTimeZone } from "date-fns-tz";
import { APP_TIME_ZONE } from "../availability/shift";

/**
 * DispatchVars へ渡す値の整形ヘルパ（フェーズ13 / spec 8-3）。
 *
 * DB 非依存の純粋関数。予約行 → DispatchVars の DB クエリは admin-ui の
 * Server Action が担い、ここは受け取った素の値（整数円・Date・スナップショット）
 * を表示文字列に整形するだけ。
 * 金額は整数（円）のみ。小数・非整数は RangeError（CLAUDE.md 禁止事項）。
 */

/** 曜日（日本語1文字）。locale 依存を避け固定表とする（全処理 Asia/Tokyo） */
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

function assertIntYen(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} は整数（円）であること: ${value}`);
  }
}

/** 円の整数を "¥12,000" に整形する（{{合計金額}} {{バック額}} 用） */
export function formatYen(amount: number): string {
  assertIntYen(amount, "amount");
  const abs = Math.abs(amount).toLocaleString("en-US"); // 3桁区切り（"12,000"）
  return `${amount < 0 ? "-" : ""}¥${abs}`;
}

/** 施術開始などを "M/d(曜) HH:mm" に整形する（{{日時}} 用 / Asia/Tokyo） */
export function formatDispatchDateTime(
  at: Date,
  timeZone: string = APP_TIME_ZONE,
): string {
  const md = formatInTimeZone(at, timeZone, "M/d");
  const hm = formatInTimeZone(at, timeZone, "HH:mm");
  // "i" = ISO 曜日（1=月..7=日）。7%7=0 で日曜を先頭にした固定表を引く
  const isoDay = Number(formatInTimeZone(at, timeZone, "i"));
  const weekday = WEEKDAYS_JA[isoDay % 7] ?? "";
  return `${md}(${weekday}) ${hm}`;
}

/** depart_at などを "HH:mm" に整形する（{{出発目安}} 用 / Asia/Tokyo） */
export function formatTimeHM(
  at: Date,
  timeZone: string = APP_TIME_ZONE,
): string {
  return formatInTimeZone(at, timeZone, "HH:mm");
}

/** 移動手段の表示（{{移動手段}} 用。空き枠エンジンの travel mode と同じ2値） */
export function formatTravelMode(mode: "walk" | "car"): string {
  return mode === "car" ? "車" : "徒歩";
}

/**
 * オプション1件のバック額（円・整数）。
 * reservation_options のスナップショット（back_type_snapshot / back_value_snapshot /
 * price_snapshot）から算出する。'fixed' = 固定額（円）、'rate' = 率（%、端数切り捨て）。
 *
 * 注: コース単位のバックレート（payout_rates）はフェーズ18のモデル。
 * それまで {{バック額}} は「オプションバック合計のみの暫定値」として
 * 本関数の合計を渡すか、未確定なら渡さない（トークンは空文字化され落ちない）。
 */
export function optionBackYen(
  backType: "fixed" | "rate",
  backValue: number,
  priceSnapshot: number,
): number {
  assertIntYen(backValue, "backValue");
  assertIntYen(priceSnapshot, "priceSnapshot");
  if (backValue < 0 || priceSnapshot < 0) {
    throw new RangeError(
      `バックの入力は0以上であること: backValue=${backValue}, price=${priceSnapshot}`,
    );
  }
  if (backType === "fixed") return backValue;
  return Math.floor((priceSnapshot * backValue) / 100);
}
