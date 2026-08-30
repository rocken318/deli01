/**
 * ポイント台帳ドメイン（spec 9章 ★ L821-849）。
 * DB にも Next.js にも依存しない純粋関数のみ。すべて整数（小数は RangeError）。
 * 追記専用台帳の共通規約（ledger.ts）はフェーズ17/18 が再利用する。
 */

export { assertInt, sumLedger, balance } from "./ledger";
export {
  activeLots,
  consumeFifo,
  expiredLots,
  expiring,
  isActiveLot,
} from "./fifo";
export type { ConsumeFifoResult, LotConsumption, PointLot } from "./fifo";
export { earnedPoints } from "./earn";
export { clampUse } from "./clamp";
export type { ClampUseReason, ClampUseResult } from "./clamp";
