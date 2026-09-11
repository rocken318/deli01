/**
 * 当日給料（日払い精算）の計算（設計 4.8）。整数円のみ。
 * 支払額 = 合計 − 雑費、雑費 = floor(合計 × 率% / 100)（切り捨て確定）。
 */
export interface DayPay { gross: number; misc: number; pay: number; }

export function computeDayPay(gross: number, miscRatePercent: number): DayPay {
  const misc = Math.floor((gross * miscRatePercent) / 100);
  return { gross, misc, pay: gross - misc };
}
