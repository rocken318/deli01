/**
 * キャンセル料の算定（フェーズ15 / spec 6章 L648・11-2 L918-919）。
 *
 * DB 非依存の純粋関数。料率は CMS（site_settings.cancellation_policy）から呼び出し側が
 * 渡す（「何時間前から何%」の段階制）。金額はすべて整数（円）。切り捨て。
 *
 * 注: 売上台帳（revenue_lines）への計上とセラピストへのバック配分はフェーズ17/18。
 * ここでは顧客に請求するキャンセル料の**金額算定まで**。
 */

/** キャンセルポリシーの1段（「minHoursBefore 時間前から percent%」） */
export interface CancellationTier {
  /** この時間以上前なら percent%（時間・0以上の整数） */
  minHoursBefore: number;
  /** 請求率（0-100 の整数） */
  percent: number;
}

/** spec 6章の雛形（CMS 未設定時のフォールバック。CMS から変更が正 / spec 13章） */
export const DEFAULT_CANCELLATION_POLICY: readonly CancellationTier[] = [
  { minHoursBefore: 24, percent: 0 }, // 前日（24時間前）まで無料
  { minHoursBefore: 3, percent: 30 }, // 3時間前まで 30%
  { minHoursBefore: 0, percent: 50 }, // 当日（開始前）50%
];

/** 開始後（no-show 含む）のキャンセル率（%）。spec 既定は全額。 */
export const AFTER_START_PERCENT = 100;

function assertInt(value: number, label: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${label} は ${min} 以上の整数であること: ${value}`);
  }
}

/**
 * キャンセル料（円・整数・切り捨て）。
 *
 * @param policy         段階制の料率（minHoursBefore 降順でなくてもよい。内部でソート）
 * @param hoursBeforeStart 開始まで残り何時間か（負値＝開始後）
 * @param baseAmount     請求の基礎額（円・整数。通常は total_amount）
 * @param isNoShow       無断キャンセルなら true（開始後扱い＝AFTER_START_PERCENT）
 */
export function cancellationFee(params: {
  policy?: readonly CancellationTier[];
  hoursBeforeStart: number;
  baseAmount: number;
  isNoShow?: boolean;
}): number {
  const policy = params.policy ?? DEFAULT_CANCELLATION_POLICY;
  assertInt(params.baseAmount, "baseAmount", 0);

  const percent = cancellationPercent({
    policy,
    hoursBeforeStart: params.hoursBeforeStart,
    isNoShow: params.isNoShow ?? false,
  });
  return Math.floor((params.baseAmount * percent) / 100);
}

/** 適用される請求率（%）だけを返す（UI の明示用 / spec 6章 L648「予約前に明示」）。 */
export function cancellationPercent(params: {
  policy?: readonly CancellationTier[];
  hoursBeforeStart: number;
  isNoShow?: boolean;
}): number {
  const policy = params.policy ?? DEFAULT_CANCELLATION_POLICY;
  for (const tier of policy) {
    assertInt(tier.minHoursBefore, "minHoursBefore", 0);
    assertInt(tier.percent, "percent", 0);
    if (tier.percent > 100) {
      throw new RangeError(`percent は 100 以下であること: ${tier.percent}`);
    }
  }

  if (params.isNoShow) return AFTER_START_PERCENT;

  // minHoursBefore 降順で「残り時間がその閾値以上」の最初の段を採用
  const sorted = [...policy].sort((a, b) => b.minHoursBefore - a.minHoursBefore);
  for (const tier of sorted) {
    if (params.hoursBeforeStart >= tier.minHoursBefore) {
      return tier.percent;
    }
  }
  // どの段にも満たない＝開始後
  return AFTER_START_PERCENT;
}
