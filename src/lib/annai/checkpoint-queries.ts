import "server-only";
import type { TransactionSql } from "postgres";

export interface SettleResult {
  reservationId: string;
  totalAmount: number;
  collectedAmount: number;
  diff: number; // collected - total（0=一致 / 負=不足 / 正=過多）
}

/** 入室電話（お客様から入室連絡）の記録。RLS 下（owner/admin/reception）で呼ぶ。 */
export async function recordEntryCallCore(
  tx: TransactionSql,
  reservationId: string,
  nowMs: number,
): Promise<{ entryCallAt: Date } | null> {
  const now = new Date(nowMs);
  const rows = await tx<{ entry_call_at: Date }[]>`
    update reservations set entry_call_at = ${now}
    where id = ${reservationId} and status in ('confirmed','enroute','in_service','done')
    returning entry_call_at
  `;
  return rows[0] ? { entryCallAt: rows[0].entry_call_at } : null;
}

/**
 * 清算（集金照合）を締める。回収額を控え、誰が・いつ・カード決済かを記録。
 * 総額との差額を返す（照合結果はUIで表示）。会計台帳(revenue_lines)は別系統で不変。
 */
export async function settleReservationCore(
  tx: TransactionSql,
  reservationId: string,
  collectedAmount: number,
  isCard: boolean,
  actorUserId: string,
  nowMs: number,
): Promise<SettleResult | null> {
  const now = new Date(nowMs);
  const rows = await tx<{ total_amount: number; collected_amount: number }[]>`
    update reservations
    set collected_amount = ${collectedAmount},
        collected_at     = ${now},
        collected_by     = ${actorUserId},
        is_card_payment  = ${isCard}
    where id = ${reservationId} and status = 'done'
    returning total_amount, collected_amount
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    reservationId,
    totalAmount: r.total_amount,
    collectedAmount: r.collected_amount,
    diff: r.collected_amount - r.total_amount,
  };
}
