/**
 * 直前割（フラッシュディール）の純粋関数（フェーズ20 / spec L650-654）。
 *
 * DB にも Next.js にも依存しない。時刻の JST 変換は呼び出し側
 * （src/lib/flashdeal/queries.ts）が DB の `at time zone 'Asia/Tokyo'` で確定し、
 * ここには分解済みの整数（時・当日フラグ）だけを渡す（日時を文字列で計算しない）。
 *
 * 金銭原則: 金額は整数（円）のみ。割引額は floor で切り捨て（顧客有利に丸めない
 * 事業側切り捨て = 割引を大きくしない方向）。
 */

/** 直前割の CMS 設定（site_settings.flash_deal_config の写像 / spec L652） */
export interface FlashDealConfig {
  /** 有効フラグ。既定 false（金銭に関わるため発注者が CMS で有効化する） */
  enabled: boolean;
  /** 割引率（整数% 1..100） */
  ratePercent: number;
  /** 対象時間帯 from（施術開始の JST 時。含む） */
  windowFromHour: number;
  /** 対象時間帯 to（JST 時。含まない。24 = その日の末尾まで） */
  windowToHour: number;
  /** 1日の適用上限件数（受入 L1120） */
  dailyLimit: number;
  /** 対象コース ID。空配列 = 全コース対象 */
  courseIds: readonly string[];
  /** 「当日この時刻（JST 時）を過ぎても埋まらない枠」に適用する基準 */
  triggerHour: number;
}

/**
 * 割引額 = floor(baseAmount × ratePercent / 100)。円・整数。
 * 不正入力（非整数・負・率が 0..100 の範囲外）は throw（金銭計算のため fail fast）。
 */
export function flashDiscount(input: {
  baseAmount: number;
  ratePercent: number;
}): number {
  const { baseAmount, ratePercent } = input;
  if (!Number.isSafeInteger(baseAmount) || baseAmount < 0) {
    throw new Error(`flashDiscount: baseAmount must be a non-negative integer (got ${baseAmount})`);
  }
  if (!Number.isSafeInteger(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    throw new Error(`flashDiscount: ratePercent must be an integer 0..100 (got ${ratePercent})`);
  }
  return Math.floor((baseAmount * ratePercent) / 100);
}

/** 不適用の理由（UI 表示・ログ用の判別コード） */
export type FlashIneligibleReason =
  | "disabled"            // 設定が無効
  | "not_same_day"        // 当日の枠でない（spec L652「当日」）
  | "before_trigger"      // まだ発火時刻前
  | "outside_window"      // 対象時間帯外
  | "course_not_covered"  // 対象コースでない
  | "daily_limit_reached"; // 1日の適用上限に達した（受入 L1120）

export type FlashEligibility =
  | { eligible: true }
  | { eligible: false; reason: FlashIneligibleReason };

/**
 * 直前割の対象判定（spec L652: 当日・発火時刻以降・対象時間帯・対象コース・1日上限）。
 *
 * - startHourJst / nowHourJst: Asia/Tokyo の時（0..23）。呼び出し側が DB で確定する
 * - isSameDayJst: 施術開始と現在が同じ JST 営業日か
 * - appliedTodayCount: 当日（JST）の適用済み件数（flash_deals の日次カウント）
 *
 * 判定順は「設定 → 当日 → 発火 → 時間帯 → コース → 上限」。
 * 予約の状態・開始済みか等の判定は呼び出し側（DB の時刻で確定できるもの）が行う。
 */
export function isFlashEligible(input: {
  config: FlashDealConfig;
  startHourJst: number;
  nowHourJst: number;
  isSameDayJst: boolean;
  courseId: string;
  appliedTodayCount: number;
}): FlashEligibility {
  const { config } = input;
  if (!config.enabled) return { eligible: false, reason: "disabled" };
  if (!input.isSameDayJst) return { eligible: false, reason: "not_same_day" };
  if (input.nowHourJst < config.triggerHour) {
    return { eligible: false, reason: "before_trigger" };
  }
  if (
    input.startHourJst < config.windowFromHour ||
    input.startHourJst >= config.windowToHour
  ) {
    return { eligible: false, reason: "outside_window" };
  }
  if (config.courseIds.length > 0 && !config.courseIds.includes(input.courseId)) {
    return { eligible: false, reason: "course_not_covered" };
  }
  if (input.appliedTodayCount >= config.dailyLimit) {
    return { eligible: false, reason: "daily_limit_reached" };
  }
  return { eligible: true };
}
