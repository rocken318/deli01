'use server';

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/booking/extension-actions';

export interface ReservationDetail {
  id: string;
  status: string;
  therapistName: string;
  customerName: string | null;
  customerPhone: string | null;
  courseName: string;
  courseDurationMin: number;
  startAtISO: string;
  endAtISO: string;
  departAtISO: string;
  areaName: string | null;
  hotelName: string | null;
  roomNumber: string | null;
  entryNote: string | null;
  options: { name: string; price: number }[];
  coursePrice: number;
  nominationFee: number;
  transportFee: number;
  totalAmount: number;
  memo: string | null;
}

export async function getReservationDetailLite(
  reservationId: string,
): Promise<ActionResult<ReservationDetail>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  const actor = toActor(session);
  if (!can(actor, 'manage_reservations')) return { ok: false, error: '権限がありません' };

  const idParsed = z.string().uuid().safeParse(reservationId);
  if (!idParsed.success) return { ok: false, error: '無効なIDです' };

  const sql = getClient();

  interface DetailRow {
    id: string;
    status: string;
    therapist_name: string | null;
    therapist_slug: string;
    customer_name: string | null;
    customer_phone: string | null;
    course_name: string;
    course_duration_min: number;
    course_price: number;
    nomination_fee: number;
    transport_fee: number;
    total_amount: number;
    start_at: Date;
    end_at: Date;
    depart_at: Date;
    area_name: string | null;
    hotel_name: string | null;
    room_number: string | null;
    memo: string | null;
  }

  interface OptionRow {
    name: string;
    price_snapshot: number;
  }

  const data = await withUser(sql, session, async (tx) => {
    const rows = await tx<DetailRow[]>`
      select
        r.id,
        r.status::text as status,
        coalesce(er.published->>'name', er.draft->>'name') as therapist_name,
        t.slug as therapist_slug,
        c.name as customer_name,
        c.phone as customer_phone,
        co.name as course_name,
        co.duration_min as course_duration_min,
        co.price as course_price,
        r.nomination_fee,
        r.transport_fee,
        r.total_amount,
        r.start_at,
        r.end_at,
        r.depart_at,
        ar.name as area_name,
        h.name as hotel_name,
        r.room_number,
        r.memo
      from reservations r
      join therapists t on t.id = r.therapist_id
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      join courses co on co.id = r.course_id
      left join areas ar on ar.id = r.area_id
      left join hotels h on h.id = r.hotel_id
      left join customers c on c.id = r.customer_id
      where r.id = ${idParsed.data}::uuid
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error('not_found');

    const optionRows = await tx<OptionRow[]>`
      select o.name, ro.price_snapshot
      from reservation_options ro
      join options o on o.id = ro.option_id
      where ro.reservation_id = ${idParsed.data}::uuid
    `;

    return {
      id: row.id,
      status: row.status,
      therapistName: row.therapist_name ?? row.therapist_slug,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      courseName: row.course_name,
      courseDurationMin: row.course_duration_min,
      startAtISO: row.start_at.toISOString(),
      endAtISO: row.end_at.toISOString(),
      departAtISO: row.depart_at.toISOString(),
      areaName: row.area_name,
      hotelName: row.hotel_name,
      roomNumber: row.room_number,
      entryNote: null,
      options: optionRows.map((o) => ({ name: o.name, price: o.price_snapshot })),
      coursePrice: row.course_price,
      nominationFee: row.nomination_fee,
      transportFee: row.transport_fee,
      totalAmount: row.total_amount,
      memo: row.memo,
    };
  });

  return { ok: true, data };
}
