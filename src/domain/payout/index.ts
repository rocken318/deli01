/**
 * 報酬（業務委託バック）純粋関数モジュール（フェーズ18 / spec 11章）。
 * DB にも Next.js にも依存しない。src/lib/payout が DB と結線する。
 */
export type {
  BusinessDate,
  PayoutCalcNote,
  PayoutCalcType,
  PayoutCategory,
  PayoutLineDraft,
  PayoutRate,
  PayoutRateScope,
  PayoutSettings,
  PayoutTargetType,
  ResolvedRate,
} from "./types";
export { DEFAULT_PAYOUT_SETTINGS } from "./types";
export { assertRate, resolveRate } from "./resolve";
export type { ResolveRateInput } from "./resolve";
export {
  buildReservationPayout,
  computePayoutLine,
  settlePayoutPeriod,
} from "./compute";
export type {
  ComputePayoutLineInput,
  PayoutPeriodSettlement,
  ReservationOutcome,
  ReservationPayoutInput,
  ReservationPayoutResult,
} from "./compute";
