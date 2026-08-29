'use server';

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { getTherapistSlots } from '@/lib/availability/public-slots';
import type { PublicSlotView } from '@/lib/availability/public-slots';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

// Customer search result
export interface CustomerSearchResult {
  id: string;
  name: string;
  nameKana: string | null;
  note: string | null;
  // Latest home address
  addressDetail: string | null;
  areaId: string | null;
  areaName: string | null;
}

export async function searchCustomerByPhone(
  phone: string,
): Promise<ActionResult<CustomerSearchResult | null>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = z.string().regex(/^0[0-9]{9,10}$/).safeParse(phone);
  if (!parsed.success) return { ok: true, data: null };

  const sql = getClient();
  const rows = await withUser(sql, session, async (tx) => {
    return tx<{
      id: string;
      name: string;
      name_kana: string | null;
      note: string | null;
      address_detail: string | null;
      area_id: string | null;
      area_name: string | null;
    }[]>`
      select c.id, c.name, c.name_kana, c.note,
             a.detail as address_detail,
             a.area_id,
             ar.name as area_name
      from customers c
      left join addresses a on a.customer_id = c.id and a.kind = 'home'
      left join areas ar on ar.id = a.area_id
      where c.phone = ${parsed.data}
      order by a.created_at desc
      limit 1
    `;
  });

  const row = rows[0] ?? null;
  if (!row) return { ok: true, data: null };

  return {
    ok: true,
    data: {
      id: row.id,
      name: row.name,
      nameKana: row.name_kana,
      note: row.note,
      addressDetail: row.address_detail,
      areaId: row.area_id,
      areaName: row.area_name,
    },
  };
}

export interface HotelSearchResult {
  id: string;
  name: string;
  nameKana: string | null;
  areaId: string | null;
  areaName: string | null;
  extraMinutes: number;
  entryNote: string | null;
}

export async function searchHotels(
  query: string,
): Promise<ActionResult<HotelSearchResult[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const q = query.trim();
  if (q.length === 0) return { ok: true, data: [] };

  const sql = getClient();
  const rows = await withUser(sql, session, async (tx) => {
    return tx<{
      id: string;
      name: string;
      name_kana: string | null;
      area_id: string | null;
      area_name: string | null;
      extra_minutes: number;
      entry_note: string | null;
    }[]>`
      select h.id, h.name, h.name_kana, h.area_id,
             a.name as area_name,
             h.extra_minutes, h.entry_note
      from hotels h
      left join areas a on a.id = h.area_id
      where h.is_blocked = false
        and (h.name ilike ${'%' + q + '%'} or h.name_kana ilike ${'%' + q + '%'})
      order by h.name asc
      limit 10
    `;
  });

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      nameKana: r.name_kana,
      areaId: r.area_id,
      areaName: r.area_name,
      extraMinutes: r.extra_minutes,
      entryNote: r.entry_note,
    })),
  };
}

const lostOrderSchema = z.object({
  phone: z.string().optional(),
  areaId: z.string().uuid().optional(),
  reason: z.enum(['time', 'area', 'nomination', 'price', 'other']),
  note: z.string().optional(),
});

export async function createLostOrder(
  data: z.infer<typeof lostOrderSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = lostOrderSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  const sql = getClient();
  const result = await withUser(sql, session, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into lost_orders (phone, area_id, reason, note, created_by)
      values (
        ${parsed.data.phone ?? null},
        ${parsed.data.areaId ?? null}::uuid,
        ${parsed.data.reason}::lost_order_reason,
        ${parsed.data.note ?? null},
        ${session.userId}::uuid
      )
      returning id
    `;
    const row = rows[0];
    if (!row) throw new Error('insert failed');
    return { id: row.id };
  });

  return { ok: true, data: result };
}

export interface OrderFormData {
  phone: string;
  customerName: string;
  destinationType: 'home' | 'hotel';
  addressDetail?: string;
  areaId?: string;
  hotelId?: string;
  roomNumber?: string;
  therapistId?: string;
  courseId: string;
  optionIds?: string[];
  startAtISO: string;
  preferences?: string;
  nominationFee?: number;
  transportFee?: number;
  totalAmount?: number;
  overrideReason?: string;
}

const orderFormSchema = z.object({
  phone: z.string().regex(/^0[0-9]{9,10}$/),
  customerName: z.string().min(1),
  destinationType: z.enum(['home', 'hotel']),
  addressDetail: z.string().optional(),
  areaId: z.string().uuid().optional(),
  hotelId: z.string().uuid().optional(),
  roomNumber: z.string().optional(),
  therapistId: z.string().uuid().optional(),
  courseId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).optional(),
  startAtISO: z.string().datetime(),
  preferences: z.string().optional(),
  nominationFee: z.number().int().min(0).optional().default(0),
  transportFee: z.number().int().min(0).optional().default(0),
  totalAmount: z.number().int().min(0).optional().default(0),
  overrideReason: z.string().optional(),
});

export async function createPhoneOrder(
  data: OrderFormData,
): Promise<ActionResult<{ reservationId: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const actor = toActor(session);
  const parsed = orderFormSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  const d = parsed.data;

  // Override slot check
  if (
    d.overrideReason !== undefined &&
    !can(actor, 'override_slot', { kind: 'slot_override', reason: d.overrideReason })
  ) {
    return { ok: false, error: '枠外予約の権限がありません' };
  }

  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      // Upsert customer
      const customers = await tx<{ id: string }[]>`
        insert into customers (phone, name)
        values (${d.phone}, ${d.customerName.trim()})
        on conflict (phone) do update
          set name = coalesce(nullif(customers.name, ''), excluded.name),
              updated_at = now()
        returning id
      `;
      const customerId = customers[0]?.id;
      if (!customerId) throw new Error('customer upsert failed');

      // Get course info
      const courses = await tx<{
        id: string;
        duration_min: number;
        price: number;
        nomination_fee_default: number;
      }[]>`
        select id, duration_min, price, nomination_fee_default
        from courses where id = ${d.courseId}::uuid and is_active = true
        limit 1
      `;
      const course = courses[0];
      if (!course) throw new Error('コースが見つかりません');

      // Get therapist
      let therapistId: string | null = d.therapistId ?? null;
      if (!therapistId) {
        // Pick first active therapist (simplified - full logic would check availability)
        const therapists = await tx<{ id: string }[]>`
          select id from therapists where status = 'active' limit 1
        `;
        therapistId = therapists[0]?.id ?? null;
      }
      if (!therapistId) throw new Error('セラピストが見つかりません');

      // Get area
      let areaId: string | null = d.areaId ?? null;
      if (!areaId && d.hotelId) {
        const hotels = await tx<{ area_id: string | null }[]>`
          select area_id from hotels where id = ${d.hotelId}::uuid limit 1
        `;
        areaId = hotels[0]?.area_id ?? null;
      }
      if (!areaId) throw new Error('エリアを指定してください');

      // Insert address
      const addresses = await tx<{ id: string }[]>`
        insert into addresses (customer_id, kind, hotel_id, label, detail, area_id)
        values (
          ${customerId}::uuid,
          ${d.destinationType === 'hotel' ? 'hotel' : 'home'}::address_kind,
          ${d.hotelId ?? null}::uuid,
          ${d.roomNumber ?? null},
          ${d.addressDetail ?? d.roomNumber ?? ''},
          ${areaId}::uuid
        )
        returning id
      `;
      const addressId = addresses[0]?.id;
      if (!addressId) throw new Error('住所の登録に失敗しました');

      const startAt = new Date(d.startAtISO);
      // Simplified times - in production, use the availability engine
      const durationMin = course.duration_min;
      const serviceEndAt = new Date(startAt.getTime() + durationMin * 60_000);
      const departAt = new Date(startAt.getTime() - 25 * 60_000);
      const freeAt = new Date(serviceEndAt.getTime() + 10 * 60_000);

      const nominationFee = d.nominationFee ?? course.nomination_fee_default;
      const transportFee = d.transportFee ?? 0;
      const totalAmount = d.totalAmount ?? (course.price + nominationFee + transportFee);

      // Insert reservation with source='phone' and phone_confirmed_at=now()
      const reservations = await tx<{ id: string }[]>`
        insert into reservations (
          therapist_id, customer_id, address_id, area_id, course_id,
          hotel_id, start_at, end_at, depart_at, free_at,
          travel_in_min, travel_out_min, buffer_min,
          status, nomination_fee, transport_fee, total_amount,
          source, phone_confirmed_at, phone_confirmed_by
        ) values (
          ${therapistId}::uuid,
          ${customerId}::uuid,
          ${addressId}::uuid,
          ${areaId}::uuid,
          ${d.courseId}::uuid,
          ${d.hotelId ?? null}::uuid,
          ${startAt}, ${serviceEndAt}, ${departAt}, ${freeAt},
          15, 15, 30,
          'confirmed',
          ${nominationFee}, ${transportFee}, ${totalAmount},
          'phone'::reservation_source,
          now(),
          ${session.userId}::uuid
        )
        returning id
      `;
      const reservationId = reservations[0]?.id;
      if (!reservationId) throw new Error('予約の作成に失敗しました');

      // Audit log for override
      if (d.overrideReason) {
        await tx`
          insert into audit_logs (actor_user_id, action, entity, entity_id, after)
          values (
            ${session.userId}::uuid,
            'override',
            'reservation',
            ${reservationId}::uuid,
            ${tx.json({ reason: d.overrideReason })}
          )
        `;
      }

      return { reservationId };
    });

    return { ok: true, data: result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}

export async function confirmPhoneCall(
  reservationId: string,
  note?: string,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsedId = z.string().uuid().safeParse(reservationId);
  if (!parsedId.success) return { ok: false, error: '無効な予約IDです' };

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      // Update reservation
      await tx`
        update reservations
        set phone_confirmed_at = now(),
            phone_confirmed_by = ${session.userId}::uuid,
            updated_at = now()
        where id = ${parsedId.data}::uuid
      `;

      // Insert call log
      await tx`
        insert into call_logs (reservation_id, result, note, called_by)
        values (
          ${parsedId.data}::uuid,
          'confirmed'::call_result,
          ${note ?? null},
          ${session.userId}::uuid
        )
      `;
    });

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}

export async function getAvailableSlots(
  date: string,
  therapistSlug?: string,
): Promise<ActionResult<PublicSlotView[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  if (!therapistSlug) {
    // Return empty if no therapist specified - calling code should pick one
    return { ok: true, data: [] };
  }

  try {
    const result = await getTherapistSlots({ slug: therapistSlug, dateISO: date });
    if (!result) return { ok: true, data: [] };
    return { ok: true, data: result.slots };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}
