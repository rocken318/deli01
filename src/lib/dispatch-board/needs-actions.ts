'use server';

/** 予約の車要否フラグ更新（設計 4.6/5.2）。権限 manage_reservations。 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';

export interface ActionResult<T = void> { ok: boolean; data?: T; error?: string; }

const schema = z.object({
  reservationId: z.string().uuid(),
  needsSendCar: z.boolean(),
  needsReturnCar: z.boolean(),
});

export async function setReservationDispatchNeeds(
  input: z.input<typeof schema>,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };
  const d = parsed.data;
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update reservations
        set needs_send_car = ${d.needsSendCar}, needs_return_car = ${d.needsReturnCar}, updated_at = now()
        where id = ${d.reservationId}::uuid
        returning id`;
    });
    if (rows.length === 0) return { ok: false, error: '予約が見つかりません' };
    revalidatePath('/admin/dispatch-board');
    revalidatePath('/admin/annai');
    revalidatePath(`/admin/reservations/${d.reservationId}`);
    return { ok: true };
  } catch (e) {
    console.error('setReservationDispatchNeeds failed:', e);
    return { ok: false, error: '車要否の更新に失敗しました' };
  }
}
