import type {
  BusinessDate,
  PayoutRate,
  PayoutTargetType,
  ResolvedRate,
} from "./types";

/**
 * レート解決（spec 11-1 L879-898・受入 L1096）。
 *
 * 優先順位: **個別（therapist_id）> ランク別（rank_id）> 既定（両方 null）**。
 * 同スコープ内では
 *   1. target_id が一致する具体レート > target_id null の汎用レート
 *   2. effective_from が新しいもの（適用開始日つき / L895）
 *   3. それでも同点なら id の辞書順で最大（決定性のため）
 * の順で1本に決める。
 *
 * 有効期間は effective_from <= businessDate < effective_to（半開区間。
 * effective_to null = 無期限）。日付は 'YYYY-MM-DD' の辞書順比較。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertBusinessDate(name: string, value: string): void {
  if (!DATE_RE.test(value)) {
    throw new RangeError(`${name} は 'YYYY-MM-DD' であること: ${value}`);
  }
}

/** レート行の妥当性（整数厳守: 率は整数% 0〜100、固定は 0 以上の円） */
export function assertRate(rate: PayoutRate): void {
  if (!Number.isSafeInteger(rate.value)) {
    throw new RangeError(`rate.value は整数であること: ${rate.value}`);
  }
  if (rate.calcType === "rate" && (rate.value < 0 || rate.value > 100)) {
    throw new RangeError(`率は 0〜100 の整数%であること: ${rate.value}`);
  }
  if (rate.calcType === "fixed" && rate.value < 0) {
    throw new RangeError(`固定額は 0 以上の円であること: ${rate.value}`);
  }
  assertBusinessDate("rate.effectiveFrom", rate.effectiveFrom);
  if (rate.effectiveTo !== null) {
    assertBusinessDate("rate.effectiveTo", rate.effectiveTo);
  }
  if (rate.therapistId !== null && rate.rankId !== null) {
    throw new RangeError(
      `個別とランク別は排他であること: rate=${rate.id}`,
    );
  }
}

export interface ResolveRateInput {
  rates: ReadonlyArray<PayoutRate>;
  therapistId: string;
  /** セラピストのランク。null = ランクなし（ランク別レートは一切当たらない） */
  rankId: string | null;
  targetType: PayoutTargetType;
  /** コースID等。null = 汎用レートのみ対象 */
  targetId: string | null;
  /** 施術の営業日（Asia/Tokyo）。この日に有効なレートを選ぶ */
  businessDate: BusinessDate;
}

/**
 * businessDate に有効なレートを 個別 > ランク別 > 既定 で1本選ぶ。
 * 該当なしは null（呼び出し側が「レート未設定」として扱う。0 円行は立てない）。
 */
export function resolveRate(input: ResolveRateInput): ResolvedRate | null {
  assertBusinessDate("businessDate", input.businessDate);

  let best: ResolvedRate | null = null;
  let bestKey: [number, number, string, string] | null = null;

  for (const rate of input.rates) {
    assertRate(rate);
    if (rate.targetType !== input.targetType) continue;
    // 有効期間: effectiveFrom <= d < effectiveTo（辞書順 = 時間順）
    if (rate.effectiveFrom > input.businessDate) continue;
    if (rate.effectiveTo !== null && rate.effectiveTo <= input.businessDate) continue;
    // 対象: 具体一致か汎用（null）のみ
    if (rate.targetId !== null && rate.targetId !== input.targetId) continue;

    // スコープ判定（他人・他ランクのレートは除外）
    let scope: ResolvedRate["scope"];
    if (rate.therapistId !== null) {
      if (rate.therapistId !== input.therapistId) continue;
      scope = "individual";
    } else if (rate.rankId !== null) {
      if (input.rankId === null || rate.rankId !== input.rankId) continue;
      scope = "rank";
    } else {
      scope = "default";
    }

    // 優先キー: [スコープ, 具体性, 適用開始日, id]（すべて大きいほど優先）
    const key: [number, number, string, string] = [
      scope === "individual" ? 2 : scope === "rank" ? 1 : 0,
      rate.targetId !== null ? 1 : 0,
      rate.effectiveFrom,
      rate.id,
    ];
    if (bestKey === null || compareKey(key, bestKey) > 0) {
      best = { rate, scope };
      bestKey = key;
    }
  }
  return best;
}

function compareKey(
  a: [number, number, string, string],
  b: [number, number, string, string],
): number {
  for (let i = 0; i < 4; i++) {
    const av = a[i] as number | string;
    const bv = b[i] as number | string;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}
