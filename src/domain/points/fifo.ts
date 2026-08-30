/**
 * ポイントの付与ロットと先入先出（FIFO）消費（spec L837）。
 * DB にも Next.js にも依存しない純粋関数。
 *
 * ロット = 台帳上の「points > 0 かつ lot_id が null」の行（earn / 正の adjust）。
 * remaining（ロット残）は呼び出し側が
 *   ロット.points + sum(そのロットを lot_id で指す行の points)
 * で算出して渡す（src/lib/points/queries.ts の SQL 参照）。
 */

import { assertInt } from "./ledger";

/** 付与ロット（earn 単位で期限を持つ / spec L831・L837） */
export interface PointLot {
  /** point_entries.id（bigint は postgres.js で文字列になる） */
  lotId: string;
  /** 未消費残（正の整数）。0 以下のロットは消費対象にならない */
  remaining: number;
  /** 付与時刻（FIFO の順序キー） */
  occurredAt: Date;
  /** 失効期限。null = 無期限 */
  expiresAt: Date | null;
}

/** あるロットからいくら消費（または失効で相殺）するかの内訳 */
export interface LotConsumption {
  lotId: string;
  /** 正の整数 */
  amount: number;
}

export type ConsumeFifoResult =
  | { ok: true; consumption: LotConsumption[]; total: number }
  | {
      ok: false;
      reason: "insufficient";
      /** 現在有効な（期限内・残ありの）消費可能合計 */
      available: number;
      /** 不足分 = usePoints - available */
      shortage: number;
    };

/** bigint 文字列 id の数値順比較（同時刻ロットの安定順序 = 追記順） */
function compareLotId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertLot(lot: PointLot): void {
  assertInt(`lots[${lot.lotId}].remaining`, lot.remaining);
}

/** 期限内（expiresAt が null または now より後）かつ残ありか */
export function isActiveLot(lot: PointLot, now: Date): boolean {
  assertLot(lot);
  return lot.remaining > 0 && (lot.expiresAt === null || lot.expiresAt.getTime() > now.getTime());
}

/** 消費対象ロット（期限切れ除外・残あり）を occurredAt 昇順 → id 昇順で返す */
export function activeLots(lots: readonly PointLot[], now: Date): PointLot[] {
  return lots
    .filter((lot) => isActiveLot(lot, now))
    .sort(
      (a, b) =>
        a.occurredAt.getTime() - b.occurredAt.getTime() || compareLotId(a.lotId, b.lotId),
    );
}

/**
 * 先入先出でポイントを消費する（spec L837「期限は付与単位・古いものから消費」）。
 * - 期限切れロットは対象外（失効は expire 行の責務であり、ここでは触らない）
 * - 残高不足は throw せず { ok: false, shortage } を返す（Server Action が文言に変換）
 */
export function consumeFifo(params: {
  lots: readonly PointLot[];
  usePoints: number;
  now: Date;
}): ConsumeFifoResult {
  assertInt("usePoints", params.usePoints);
  if (params.usePoints <= 0) {
    throw new RangeError(`usePoints は正の整数であること: ${params.usePoints}`);
  }

  const ordered = activeLots(params.lots, params.now);
  const available = ordered.reduce((sum, lot) => sum + lot.remaining, 0);
  if (available < params.usePoints) {
    return {
      ok: false,
      reason: "insufficient",
      available,
      shortage: params.usePoints - available,
    };
  }

  const consumption: LotConsumption[] = [];
  let left = params.usePoints;
  for (const lot of ordered) {
    if (left === 0) break;
    const amount = Math.min(lot.remaining, left);
    consumption.push({ lotId: lot.lotId, amount });
    left -= amount;
  }
  return { ok: true, consumption, total: params.usePoints };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 失効が withinDays 日以内に迫っている（まだ有効な）ロット一覧。
 * spec L841「失効30日前の対象一覧を出せること（連絡のため）」の核。
 */
export function expiring(params: {
  lots: readonly PointLot[];
  now: Date;
  withinDays: number;
}): PointLot[] {
  assertInt("withinDays", params.withinDays);
  if (params.withinDays < 0) {
    throw new RangeError(`withinDays は 0 以上であること: ${params.withinDays}`);
  }
  const limit = params.now.getTime() + params.withinDays * DAY_MS;
  return activeLots(params.lots, params.now).filter(
    (lot) => lot.expiresAt !== null && lot.expiresAt.getTime() <= limit,
  );
}

/**
 * 期限切れで未消費残が残っているロット → expire 行（負）で相殺すべき内訳。
 * 日次バッチ（expirePoints / cron 配線はフェーズ20）が使う。
 */
export function expiredLots(params: {
  lots: readonly PointLot[];
  now: Date;
}): LotConsumption[] {
  return params.lots
    .filter((lot) => {
      assertLot(lot);
      return (
        lot.remaining > 0 &&
        lot.expiresAt !== null &&
        lot.expiresAt.getTime() <= params.now.getTime()
      );
    })
    .sort(
      (a, b) =>
        a.occurredAt.getTime() - b.occurredAt.getTime() || compareLotId(a.lotId, b.lotId),
    )
    .map((lot) => ({ lotId: lot.lotId, amount: lot.remaining }));
}
