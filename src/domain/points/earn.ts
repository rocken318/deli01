/**
 * ポイント付与の計算（spec L838-839）。
 * 付与ルール（率・コース別・指名/初回/誕生月/紹介ボーナス・会員ランク）は
 * CMS 設定であり、**呼び出し側が解決した率・金額を渡す**純粋関数にする。
 *
 * 拡張の指針:
 * - コース別の率・ランク別の率 → 呼び出し側が ratePercent を選んで渡す
 * - 指名/初回/誕生月/紹介などの固定ボーナス → 別の earn 行として追記する
 *   （台帳が「なぜ付いたか」を reason ごとに分けて持てる。合算しない）
 */

import { assertInt } from "./ledger";

/**
 * 金額 × 率（整数%）の切り捨て。
 * 例: amount=12,340円 × 5% → 617P（小数は常に切り捨て / 金額・ポイントは整数のみ）
 */
export function earnedPoints(params: { amount: number; ratePercent: number }): number {
  assertInt("amount", params.amount);
  assertInt("ratePercent", params.ratePercent);
  if (params.amount < 0) {
    throw new RangeError(`amount は 0 以上であること: ${params.amount}`);
  }
  if (params.ratePercent < 0 || params.ratePercent > 100) {
    throw new RangeError(`ratePercent は 0..100 であること: ${params.ratePercent}`);
  }
  return Math.floor((params.amount * params.ratePercent) / 100);
}
