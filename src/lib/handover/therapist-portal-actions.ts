'use server';

/**
 * 引き継ぎメモ therapist 経路（フェーズ16 / spec 9章 L810-814）。
 *
 * - getHandoverNotesForReservation: reservationId から customer_id を解決し、
 *   その顧客の過去メモを取得する。RLS により therapist は「次回以降の自分の担当
 *   予約がある顧客」のメモのみ select できる（受入 L1123）。
 * - addHandoverNoteFromMypage: マイページの「完了」前後に一言残す。
 *
 * 電話番号は一切 select しない（dispatch-board/queries.ts と同じ方針）。
 *
 * セッション解決: getTherapistDevSession（dev 限定）。
 * TODO(live Auth): src/lib/auth/ の live SessionProvider に差し替える。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { withUser } from '@/lib/auth/with-user';
import { getTherapistDevSession } from '@/lib/cms/dev-session';
import { addHandoverNoteCore, getHandoverNotesCore } from './queries';
import type { HandoverNote } from './queries';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const uuidSchema = z.string().uuid();

const addSchema = z.object({
  reservationId: z.string().uuid(),
  body: z
    .string()
    .trim()
    .min(1, '引き継ぎメモを入力してください')
    .max(500, '引き継ぎメモは500文字以内です'),
});

/**
 * reservationId を起点に、その顧客の過去引き継ぎメモを取得する。
 * therapist セッション専用（getTherapistDevSession）。
 *
 * TherapistTimelineItem に customerId が含まれないため、
 * reservationId → customer_id の解決を DB で行う。
 *
 * 手順:
 * 1. reservations から customer_id を取得（RLS: therapist は自分の担当のみ行が返る）
 * 2. getHandoverNotesCore で顧客のメモを取得
 *    （RLS: 次回以降の自分の担当予約があるときのみ行が返る。なければ 0 行）
 *
 * 「次回担当」がなければ RLS が 0 行を返す → UI には表示しない（漏洩しない）。
 */
export async function getHandoverNotesForReservation(
  reservationId: string,
  asSlug?: string,
): Promise<ActionResult<HandoverNote[]>> {
  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = uuidSchema.safeParse(reservationId);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const sql = getClient();

    // Step 1: reservationId → customer_id（therapist セッションで RLS 経由）
    // RLS の reservations_therapist_select が therapist_id = session.therapistId に絞る
    const customerId = await withUser<string | null>(sql, session, async (tx) => {
      const rows = await tx<{ customer_id: string | null }[]>`
        select customer_id
        from reservations
        where id = ${parsed.data}::uuid
        limit 1
      `;
      return rows[0]?.customer_id ?? null;
    });

    if (!customerId) {
      // 自分の担当外（RLS が 0 行）または customer 未紐付け → 空を返す（エラーではない）
      return { ok: true, data: [] };
    }

    // Step 2: customer_id でメモ取得（therapist セッション・RLS が次回担当を検証）
    const notes = await getHandoverNotesCore(sql, session, { customerId });
    return { ok: true, data: notes };
  } catch (e) {
    console.error('getHandoverNotesForReservation failed:', e);
    return { ok: false, error: '引き継ぎメモの取得に失敗しました' };
  }
}

/**
 * マイページから引き継ぎメモを追加する。
 * therapist セッション専用。in_service/done の自分の担当予約のみ（RLS + コアで二重ガード）。
 *
 * UI 側の義務: 入力欄に「人格・容姿への言及は禁止（開示請求で本人が閲覧しうる）」を
 * 常時表示すること（spec L814）。
 */
export async function addHandoverNoteFromMypage(
  reservationId: string,
  body: string,
  asSlug?: string,
): Promise<ActionResult<{ noteId: string }>> {
  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = addSchema.safeParse({ reservationId, body });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '入力が不正です' };
  }

  try {
    const outcome = await addHandoverNoteCore(getClient(), session, parsed.data);
    switch (outcome.kind) {
      case 'ok':
        return { ok: true, data: { noteId: outcome.noteId } };
      case 'reservation_not_found':
        return { ok: false, error: '対象の予約が見つかりません' };
      case 'not_completed':
        return { ok: false, error: '施術中または完了した予約にのみ残せます' };
      case 'forbidden':
        return { ok: false, error: 'この操作はセラピスト本人のみ可能です' };
    }
  } catch (e) {
    console.error('addHandoverNoteFromMypage failed:', e);
    return { ok: false, error: '引き継ぎメモの保存に失敗しました' };
  }
}
