'use server';

/**
 * 予約の部屋番号を更新する薄い Server Action（フェーズ: reservation-card-ops-room）。
 * 権限: manage_reservations。マイグレーション不要（room_number 列は 0025 で追加済み）。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const roomNumberSchema = z.object({
  reservationId: z.string().uuid(),
  roomNumber: z.string().max(50),
});

/**
 * 予約の部屋番号を更新する。空文字列は null に変換（未設定）。
 */
export async function setReservationRoomNumber(input: {
  reservationId: string;
  roomNumber: string;
}): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '予約を操作する権限がありません' };
  }

  const parsed = roomNumberSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  const { reservationId, roomNumber } = parsed.data;
  const roomNumberValue = roomNumber.trim() === '' ? null : roomNumber.trim();

  const sql = getClient();

  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update reservations
        set room_number = ${roomNumberValue},
            updated_at  = now()
        where id = ${reservationId}::uuid
        returning id
      `;
    });

    if (rows.length === 0) {
      return { ok: false, error: '予約が見つかりません' };
    }

    revalidatePath('/admin/reservation-list');
    revalidatePath('/admin/dispatch-board');
    return { ok: true };
  } catch (e) {
    console.error('setReservationRoomNumber failed:', e);
    return { ok: false, error: '部屋番号の更新に失敗しました' };
  }
}
