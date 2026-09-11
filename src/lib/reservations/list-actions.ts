"use server";

/**
 * 予約一覧（日別）の取得と手動並べ替え（設計 フェーズ11）。
 * 権限: manage_reservations（owner/admin/reception）。
 */

import { revalidatePath } from "next/cache";
import { addDays } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import { withUser } from "@/lib/auth/with-user";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";

const APP_TZ = "Asia/Tokyo";
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function dayBounds(dateISO: string): { dayStart: Date; dayEnd: Date } {
  if (!DATE_RE.test(dateISO)) {
    throw new RangeError(`dateISO は "YYYY-MM-DD" であること: ${dateISO}`);
  }
  const dayStart = fromZonedTime(`${dateISO}T00:00:00`, APP_TZ);
  return { dayStart, dayEnd: addDays(dayStart, 1) };
}

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface ReservationListItem {
  id: string;
  therapistName: string;
  customerName: string | null;
  courseName: string;
  courseDurationMin: number;
  coursePrice: number;
  nominationFee: number;
  transportFee: number;
  totalAmount: number;
  options: { name: string; price: number }[];
  areaName: string | null;
  hotelName: string | null;
  hotelId: string | null;
  roomNumber: string | null;
  startAtISO: string;
  endAtISO: string;
  status: string;
  manualSortOrder: number | null;
  needsSendCar: boolean;
  needsReturnCar: boolean;
}

interface ListRow {
  id: string;
  therapist_name: string | null;
  therapist_slug: string;
  customer_name: string | null;
  course_name: string;
  course_duration_min: number;
  course_price: number;
  nomination_fee: number;
  transport_fee: number;
  total_amount: number;
  area_name: string | null;
  hotel_name: string | null;
  hotel_id: string | null;
  room_number: string | null;
  start_at: Date;
  end_at: Date;
  status: string;
  manual_sort_order: number | null;
  needs_send_car: boolean;
  needs_return_car: boolean;
}

interface OptionRow {
  reservation_id: string;
  name: string;
  price_snapshot: number;
}

// ---------------------------------------------------------------------------
// 1. 予約一覧取得
// ---------------------------------------------------------------------------

/**
 * 当日（Asia/Tokyo の dateISO の日）の予約一覧を返す。
 * cancelled/noshow を除外。
 * 既定並び: manual_sort_order asc nulls last, start_at asc。
 */
export async function getReservationList(
  dateISO: string,
): Promise<ReservationListItem[]> {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_reservations")) {
    return [];
  }

  const { dayStart, dayEnd } = dayBounds(dateISO);
  const sql = getClient();

  const [rows, optionRows] = await withUser(sql, session, async (tx) => {
    const reservations = await tx<ListRow[]>`
      select
        r.id,
        er.published->>'name'    as therapist_name,
        t.slug                   as therapist_slug,
        c.name                   as customer_name,
        co.name                  as course_name,
        co.duration_min          as course_duration_min,
        co.price                 as course_price,
        r.nomination_fee,
        r.transport_fee,
        r.total_amount,
        ar.name                  as area_name,
        h.name                   as hotel_name,
        r.hotel_id,
        r.room_number,
        r.start_at,
        r.end_at,
        r.status::text           as status,
        r.manual_sort_order,
        r.needs_send_car,
        r.needs_return_car
      from reservations r
      join therapists t on t.id = r.therapist_id
      left join entity_records er
             on er.entity = 'therapist' and er.slug = t.slug
      join courses co on co.id = r.course_id
      left join areas ar on ar.id = r.area_id
      left join hotels h on h.id = r.hotel_id
      left join customers c on c.id = r.customer_id
      where r.start_at >= ${dayStart} and r.start_at < ${dayEnd}
        and r.status in ('held', 'confirmed', 'enroute', 'in_service', 'done')
      order by r.manual_sort_order asc nulls last, r.start_at asc
    `;

    if (reservations.length === 0) {
      return [reservations, [] as OptionRow[]] as const;
    }

    const ids = reservations.map((r) => r.id);
    const options = await tx<OptionRow[]>`
      select ro.reservation_id, o.name, ro.price_snapshot
      from reservation_options ro
      join options o on o.id = ro.option_id
      where ro.reservation_id = any(${ids}::uuid[])
    `;

    return [reservations, options] as const;
  });

  // Bundle options by reservation id
  const optionsByResId = new Map<string, { name: string; price: number }[]>();
  for (const o of optionRows) {
    const arr = optionsByResId.get(o.reservation_id) ?? [];
    arr.push({ name: o.name, price: o.price_snapshot });
    optionsByResId.set(o.reservation_id, arr);
  }

  return rows.map((r) => ({
    id: r.id,
    therapistName: r.therapist_name ?? r.therapist_slug,
    customerName: r.customer_name,
    courseName: r.course_name,
    courseDurationMin: r.course_duration_min,
    coursePrice: r.course_price,
    nominationFee: r.nomination_fee,
    transportFee: r.transport_fee,
    totalAmount: r.total_amount,
    options: optionsByResId.get(r.id) ?? [],
    areaName: r.area_name,
    hotelName: r.hotel_name,
    hotelId: r.hotel_id,
    roomNumber: r.room_number,
    startAtISO: r.start_at.toISOString(),
    endAtISO: r.end_at.toISOString(),
    status: r.status,
    manualSortOrder: r.manual_sort_order,
    needsSendCar: r.needs_send_car,
    needsReturnCar: r.needs_return_car,
  }));
}

// ---------------------------------------------------------------------------
// 2. 手動並べ替え保存
// ---------------------------------------------------------------------------

const reorderSchema = z.object({
  dateISO: z.string().regex(DATE_RE),
  orderedIds: z.array(z.string().uuid()).min(1),
});

/**
 * orderedIds の順番に manual_sort_order = index（0..n）を一括 update する。
 * 対象: その日の予約のみ（別日の予約は変更しない）。
 */
export async function reorderReservations(input: {
  dateISO: string;
  orderedIds: string[];
}): Promise<{ ok: boolean; error?: string }> {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_reservations")) {
    return { ok: false, error: "権限がありません" };
  }

  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "入力が不正です" };
  }

  const { dateISO, orderedIds } = parsed.data;
  const { dayStart, dayEnd } = dayBounds(dateISO);
  const sql = getClient();

  await withUser(sql, session, async (tx) => {
    // 各 ID に index を振って一括 update（トランザクション内）
    for (let i = 0; i < orderedIds.length; i++) {
      await tx`
        update reservations
        set manual_sort_order = ${i},
            updated_at        = now()
        where id         = ${orderedIds[i]!}::uuid
          and start_at  >= ${dayStart}
          and start_at  <  ${dayEnd}
      `;
    }
  });

  revalidatePath("/admin/reservation-list");
  return { ok: true };
}
