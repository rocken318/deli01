import "server-only";
import type { TransactionSql } from "postgres";

export interface SettleResult {
  reservationId: string;
  totalAmount: number;
  collectedAmount: number;
  diff: number; // collected - total（0=一致 / 負=不足 / 正=過多）
  reconciledAt: Date;
}

export type SettleOutcome =
  | { kind: "ok"; data: SettleResult }
  | { kind: "note_required" } // 差額≠0 なのにメモ無し
  | { kind: "not_settleable" }; // done でない / 既に清算済み / 他人（RLS）

/** 入室電話（お客様から入室連絡）を set-once で記録。RLS 下（owner/admin/reception）で呼ぶ。 */
export async function recordEntryCallCore(
  tx: TransactionSql,
  reservationId: string,
  nowMs: number,
): Promise<{ entryCallAt: Date } | null> {
  const now = new Date(nowMs);
  const rows = await tx<{ entry_call_at: Date }[]>`
    update reservations set entry_call_at = ${now}
    where id = ${reservationId}
      and entry_call_at is null
      and status in ('confirmed','enroute','in_service','done')
    returning entry_call_at
  `;
  return rows[0] ? { entryCallAt: rows[0].entry_call_at } : null;
}

/**
 * 清算（集金照合）を締める。追記専用の思想: done かつ未清算のときだけ。
 * 差額≠0 のときは settle_note 必須。締めた事実は audit_logs にも追記する。
 * 会計台帳(revenue_lines)は別系統で不変。
 */
export async function settleReservationCore(
  tx: TransactionSql,
  reservationId: string,
  collectedAmount: number,
  isCard: boolean,
  note: string,
  actorUserId: string,
  nowMs: number,
): Promise<SettleOutcome> {
  // done かつ未清算のみ対象（再清算は拒否＝上書き防止）
  const target = await tx<{ total_amount: number }[]>`
    select total_amount from reservations
    where id = ${reservationId} and status = 'done' and reconciled_at is null
    for update
  `;
  const t = target[0];
  if (!t) return { kind: "not_settleable" };

  const diff = collectedAmount - t.total_amount;
  if (diff !== 0 && note.trim().length === 0) return { kind: "note_required" };

  const now = new Date(nowMs);
  await tx`
    update reservations
    set collected_amount = ${collectedAmount},
        reconciled_at    = ${now},
        reconciled_by    = ${actorUserId},
        is_card_payment  = ${isCard},
        settle_note      = ${note.trim() || null}
    where id = ${reservationId}
  `;
  await tx`
    insert into audit_logs (actor_user_id, action, entity, entity_id, after)
    values (${actorUserId}, 'settle', 'reservation', ${reservationId}, ${tx.json({
      collectedAmount,
      totalAmount: t.total_amount,
      diff,
      isCard,
      note: note.trim() || null,
    })})
  `;

  return {
    kind: "ok",
    data: { reservationId, totalAmount: t.total_amount, collectedAmount, diff, reconciledAt: now },
  };
}
