import { formatInTimeZone } from "date-fns-tz";
import { APP_TIME_ZONE } from "../availability/shift";

/**
 * 予約料金の純粋関数（フェーズ11 / spec 6章・18-3）。
 *
 * DB にも Next.js にも依存しない。設定値（交通費・深夜加算）は CMS
 * （site_settings.booking_fees）から呼び出し側が渡す。金額はすべて整数（円）。
 * 小数・負数は RangeError（CLAUDE.md 禁止事項）。
 *
 * spec 18-3（ダミー初期値。CMS から変更できることをもって完成）:
 * - 交通費: 徒歩圏 ¥0 / 車 ¥1,000（遠方 ¥2,000〜3,000 の段階制はエリア距離の
 *   区分が入るフェーズ12以降で拡張。本フェーズは手段による2段階）
 * - 深夜加算: 24:00〜5:00 **開始** の施術に ¥3,000
 *
 * ポイント値引（spec 6章 手順8）はフェーズ16。ここでは枠だけ設けない
 * （合計 = コース + オプション + 指名料 + 交通費 + 深夜加算）。
 */

/** 料金設定（site_settings.booking_fees の写像。すべて整数円 / 時は 0-23） */
export interface BookingFeeSettings {
  /** 交通費: 徒歩圏（既定 0） */
  transportWalk: number;
  /** 交通費: 車（既定 1000） */
  transportCar: number;
  /** 深夜加算額（既定 3000） */
  midnightSurcharge: number;
  /** 深夜帯の開始時（含む。既定 0 = 24:00） */
  midnightFromHour: number;
  /** 深夜帯の終了時（含まない。既定 5 = 5:00 開始から通常） */
  midnightToHour: number;
  /** 受付リードタイム（分）。「今から何分後以降なら予約可」。既定 60（発注者決定 2026-09-05） */
  leadTimeMin: number;
}

/** spec 18-3 のダミー既定値（CMS 未設定時のフォールバック） */
export const DEFAULT_BOOKING_FEES: BookingFeeSettings = {
  transportWalk: 0,
  transportCar: 1000,
  midnightSurcharge: 3000,
  midnightFromHour: 0,
  midnightToHour: 5,
  leadTimeMin: 60,
};

function assertIntMin(value: number, label: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${label} は ${min} 以上の整数であること: ${value}`);
  }
}

function assertSettings(s: BookingFeeSettings): void {
  assertIntMin(s.transportWalk, "transportWalk", 0);
  assertIntMin(s.transportCar, "transportCar", 0);
  assertIntMin(s.midnightSurcharge, "midnightSurcharge", 0);
  assertIntMin(s.midnightFromHour, "midnightFromHour", 0);
  assertIntMin(s.midnightToHour, "midnightToHour", 0);
  assertIntMin(s.leadTimeMin, "leadTimeMin", 0);
  if (s.midnightFromHour > 23 || s.midnightToHour > 24) {
    throw new RangeError(
      `深夜帯の時刻が不正: ${s.midnightFromHour}〜${s.midnightToHour}`,
    );
  }
}

/**
 * 交通費（円・整数）。徒歩圏は 0、車はエリア別の固定額（spec 3-8・18-3）。
 * 判定は空き枠エンジンが出した到着側の移動手段（travelInMode）に従う。
 *
 * areaFee（areas.transport_fee のスナップショット。税別・整数円）が渡されれば
 * 車のときそれを使う（エリア別固定額 / 発注者決定 2026-09-04）。未指定なら従来の
 * 一律 settings.transportCar にフォールバックする。徒歩圏は常に transportWalk（既定 0）。
 */
export function transportFee(
  travelInMode: "walk" | "car",
  settings: BookingFeeSettings = DEFAULT_BOOKING_FEES,
  areaFee?: number | null,
): number {
  assertSettings(settings);
  if (travelInMode !== "car") return settings.transportWalk;
  if (areaFee != null) {
    assertIntMin(areaFee, "areaFee", 0);
    return areaFee;
  }
  return settings.transportCar;
}

/**
 * 深夜加算（円・整数）。施術開始（start_at）の Asia/Tokyo の時刻が
 * [midnightFromHour, midnightToHour) に入るとき加算する（spec 18-3:
 * 「24:00〜5:00 開始」= 0:00 以上 5:00 未満の開始）。
 */
export function midnightSurcharge(
  startAt: Date,
  settings: BookingFeeSettings = DEFAULT_BOOKING_FEES,
  timeZone: string = APP_TIME_ZONE,
): number {
  assertSettings(settings);
  const hour = Number(formatInTimeZone(startAt, timeZone, "H"));
  const inWindow =
    settings.midnightFromHour <= settings.midnightToHour
      ? hour >= settings.midnightFromHour && hour < settings.midnightToHour
      : hour >= settings.midnightFromHour || hour < settings.midnightToHour;
  return inWindow ? settings.midnightSurcharge : 0;
}

/** 料金内訳（すべて整数円）。UI の常時合計表示と reservations の控えに使う */
export interface FeeBreakdown {
  coursePrice: number;
  optionsTotal: number;
  nominationFee: number;
  transportFee: number;
  midnightSurcharge: number;
  totalAmount: number;
}

/**
 * 合計金額（spec 6章 手順9: コース + オプション + 指名料 + 交通費 + 深夜加算）。
 * ポイント値引はフェーズ16（ここでは扱わない）。
 */
export function feeBreakdown(input: {
  coursePrice: number;
  optionPrices: readonly number[];
  nominationFee: number;
  travelInMode: "walk" | "car";
  startAt: Date;
  settings?: BookingFeeSettings;
  timeZone?: string;
  /** エリア別交通費（areas.transport_fee・税別整数円）。車のとき優先で使う */
  areaTransportFee?: number | null;
}): FeeBreakdown {
  const settings = input.settings ?? DEFAULT_BOOKING_FEES;
  assertIntMin(input.coursePrice, "coursePrice", 0);
  assertIntMin(input.nominationFee, "nominationFee", 0);
  let optionsTotal = 0;
  for (const p of input.optionPrices) {
    assertIntMin(p, "optionPrice", 0);
    optionsTotal += p;
  }
  const transport = transportFee(input.travelInMode, settings, input.areaTransportFee);
  const midnight = midnightSurcharge(input.startAt, settings, input.timeZone);
  return {
    coursePrice: input.coursePrice,
    optionsTotal,
    nominationFee: input.nominationFee,
    transportFee: transport,
    midnightSurcharge: midnight,
    totalAmount:
      input.coursePrice + optionsTotal + input.nominationFee + transport + midnight,
  };
}
