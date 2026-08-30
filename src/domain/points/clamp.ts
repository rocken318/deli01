/**
 * ポイント利用の上限・下限バリデーション（spec L840「1回の利用上限・下限を
 * 設定できること」）。制限値は CMS（site_settings.point_policy）から
 * 呼び出し側が渡す。1P = 1円の値引き（spec L840）。
 */

import { assertInt } from "./ledger";

export type ClampUseReason = "invalid" | "below_min" | "above_max" | "insufficient";

export type ClampUseResult =
  | { ok: true; use: number }
  | { ok: false; reason: ClampUseReason };

/**
 * requested をそのまま使えるかを検証する（勝手に減額しない。
 * 「上限まで自動で丸める」UI にしたければ呼び出し側が max を見て requested を作る）。
 * - requested は 1 以上の整数
 * - min 未満 → below_min / max 超過 → above_max / 残高超過 → insufficient
 */
export function clampUse(params: {
  requested: number;
  min?: number | null;
  max?: number | null;
  balance: number;
}): ClampUseResult {
  assertInt("requested", params.requested);
  assertInt("balance", params.balance);
  if (params.min != null) assertInt("min", params.min);
  if (params.max != null) assertInt("max", params.max);

  if (params.requested <= 0) return { ok: false, reason: "invalid" };
  if (params.min != null && params.requested < params.min) {
    return { ok: false, reason: "below_min" };
  }
  if (params.max != null && params.requested > params.max) {
    return { ok: false, reason: "above_max" };
  }
  if (params.requested > params.balance) {
    return { ok: false, reason: "insufficient" };
  }
  return { ok: true, use: params.requested };
}
