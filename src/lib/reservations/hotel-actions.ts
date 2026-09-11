'use server';

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/lib/booking/extension-actions';

export interface HotelChangeResult {
  /** 変更前の交通費（整数円） */
  oldFee: number;
  /** 変更後の交通費（整数円） */
  newFee: number;
  /** 変更後の合計金額（整数円）= total_amount - oldFee + newFee */
  newTotal: number;
  /** area_id が変わったか */
  areaChanged: boolean;
}

const schema = z.object({
  reservationId: z.string().uuid(),
  hotelId: z.string().uuid(),
});

export async function changeReservationHotel(params: {
  reservationId: string;
  hotelId: string;
}): Promise<ActionResult<HotelChangeResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  const actor = toActor(session);
  if (!can(actor, 'manage_reservations')) return { ok: false, error: '権限がありません' };

  const ids = schema.safeParse(params);
  if (!ids.success) return { ok: false, error: '無効なIDです' };

  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      // Fetch current reservation
      const resRows = await tx<{
        status: string;
        hotel_id: string | null;
        area_id: string | null;
        transport_fee: number;
        total_amount: number;
        version: number;
      }[]>`
        select status::text, hotel_id, area_id,
               transport_fee, total_amount, version
        from reservations
        where id = ${ids.data.reservationId}::uuid
        limit 1
      `;
      const current = resRows[0];
      if (!current) throw new Error('not_found');

      const CHANGEABLE = new Set(['held', 'confirmed', 'enroute', 'in_service']);
      if (!CHANGEABLE.has(current.status)) throw new Error('status_error');

      // Fetch new hotel + area info
      const hotelRows = await tx<{
        is_blocked: boolean;
        area_id: string | null;
        transport_fee: number | null;
        area_transport_fee: number | null;
      }[]>`
        select h.is_blocked, h.area_id,
               h.transport_fee,
               ar.transport_fee as area_transport_fee
        from hotels h
        left join areas ar on ar.id = h.area_id
        where h.id = ${ids.data.hotelId}::uuid
        limit 1
      `;
      const hotel = hotelRows[0];
      if (!hotel) throw new Error('hotel_not_found');
      if (hotel.is_blocked) throw new Error('hotel_blocked');

      // Resolve new fee: hotel-specific > area default > 0
      const newFee = hotel.transport_fee !== null
        ? Number(hotel.transport_fee)
        : hotel.area_transport_fee !== null
          ? Number(hotel.area_transport_fee)
          : 0;

      const oldFee = Number(current.transport_fee);
      const oldTotal = Number(current.total_amount);
      const newTotal = oldTotal - oldFee + newFee;

      // Determine new area_id: follow hotel's area if it has one; else keep existing
      const newAreaId = hotel.area_id ?? current.area_id;
      const areaChanged = newAreaId !== current.area_id;

      // Update reservation (optimistic lock on version)
      // area_id: if newAreaId is non-null, update it; otherwise keep the existing value
      let updated: { version: number }[];
      if (newAreaId !== null) {
        updated = await tx<{ version: number }[]>`
          update reservations
          set hotel_id      = ${ids.data.hotelId}::uuid,
              area_id       = ${newAreaId}::uuid,
              transport_fee = ${newFee},
              total_amount  = ${newTotal},
              version       = version + 1,
              updated_at    = now()
          where id      = ${ids.data.reservationId}::uuid
            and version = ${current.version}
          returning version
        `;
      } else {
        updated = await tx<{ version: number }[]>`
          update reservations
          set hotel_id      = ${ids.data.hotelId}::uuid,
              transport_fee = ${newFee},
              total_amount  = ${newTotal},
              version       = version + 1,
              updated_at    = now()
          where id      = ${ids.data.reservationId}::uuid
            and version = ${current.version}
          returning version
        `;
      }
      if (!updated[0]) throw new Error('version_conflict');

      // Audit log
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, before, after)
        values (
          ${session.userId}::uuid,
          'hotel_change',
          'reservation',
          ${ids.data.reservationId}::uuid,
          ${tx.json({
            hotelId: current.hotel_id,
            areaId: current.area_id,
            transportFee: oldFee,
            totalAmount: oldTotal,
          })},
          ${tx.json({
            hotelId: ids.data.hotelId,
            areaId: newAreaId,
            transportFee: newFee,
            totalAmount: newTotal,
            newFee,
          })}
        )
      `;

      return { oldFee, newFee, newTotal, areaChanged };
    });

    revalidatePath('/admin/dispatch-board');
    revalidatePath('/admin/reservation-list');
    revalidatePath('/admin/annai');

    return { ok: true, data: result };
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'status_error') {
        return { ok: false, error: '完了/取消済みの予約は変更できません' };
      }
      if (e.message === 'not_found') {
        return { ok: false, error: '予約が見つかりません' };
      }
      if (e.message === 'hotel_not_found') {
        return { ok: false, error: 'ホテルが見つかりません' };
      }
      if (e.message === 'hotel_blocked') {
        return { ok: false, error: 'このホテルは受け入れ停止中です' };
      }
      if (e.message === 'version_conflict') {
        return { ok: false, error: '他の操作と競合しました。画面を更新してからやり直してください' };
      }
    }
    console.error('changeReservationHotel failed:', e);
    return { ok: false, error: 'ホテル変更に失敗しました' };
  }
}
