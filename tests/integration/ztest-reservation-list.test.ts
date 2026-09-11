import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  getReservationList,
  reorderReservations,
} from "@/lib/reservations/list-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const TZ = "Asia/Tokyo";

let aoiId: string;
let customerId: string;
let addressId: string;
let resId1: string;
let resId2: string;
let resDate: string;

const TEST_PHONE = "0907777" + String(Date.now()).slice(-4);

async function insertReservation(offsetHours: number): Promise<string> {
  const id = randomUUID();
  // Use today's date in JST but with an explicit time that's offset by hours
  const now = new Date();
  const todayJST = formatInTimeZone(now, TZ, "yyyy-MM-dd");
  // Place reservations at 13:00 and 16:00 JST (well within the same operating day)
  const startISO = `${todayJST}T${String(13 + offsetHours).padStart(2, "0")}:00:00+09:00`;
  const start = new Date(startISO);
  const end = new Date(start.getTime() + 3_600_000); // +1h
  const depart = new Date(start.getTime() - 900_000); // -15min travel
  const free = new Date(end.getTime() + 2_700_000); // +45min (service + buffer)

  await sql`
    insert into reservations (
      id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min, status, total_amount
    ) values (
      ${id}::uuid, ${aoiId}::uuid, ${customerId}::uuid, ${addressId}::uuid,
      (select id from areas limit 1), (select id from courses limit 1),
      ${start}, ${end}, ${depart}, ${free}, 15, 30, 5, 'confirmed'::reservation_status, 15000
    ) on conflict (id) do nothing`;
  return id;
}

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;

  customerId = (await sql<{ id: string }[]>`
    insert into customers (phone, name)
    values (${TEST_PHONE}, '一覧テスト顧客')
    on conflict (phone) do update set name = excluded.name
    returning id`)[0]!.id;

  addressId = (await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id, label)
    values (${customerId}::uuid, 'home', '一覧テスト住所', (select id from areas limit 1), '一覧テスト')
    returning id`)[0]!.id;

  // Insert two reservations spaced 3 hours apart to avoid therapist-overlap exclusion
  resId1 = await insertReservation(0); // 13:00 JST
  resId2 = await insertReservation(3); // 16:00 JST

  resDate = formatInTimeZone(
    (await sql<{ start_at: Date }[]>`select start_at from reservations where id=${resId1}::uuid`)[0]!.start_at,
    TZ, "yyyy-MM-dd");
});

afterAll(async () => {
  await sql`update reservations set manual_sort_order = null where id in (${resId1}::uuid, ${resId2}::uuid)`;
  await sql`delete from reservations where id in (${resId1}::uuid, ${resId2}::uuid)`;
  await sql`delete from addresses where id = ${addressId}::uuid`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("getReservationList", () => {
  it("当日の予約を2件返す（cancelled/noshow を除外）", async () => {
    const result = await getReservationList(resDate);
    // Should include our 2 reservations (confirmed status)
    const ours = result.filter((r) => r.id === resId1 || r.id === resId2);
    expect(ours).toHaveLength(2);
  });

  it("各件に必要なフィールドが揃っている", async () => {
    const result = await getReservationList(resDate);
    const r = result.find((x) => x.id === resId1)!;
    expect(r).toBeDefined();
    expect(r.id).toBe(resId1);
    expect(typeof r.therapistName).toBe("string");
    expect(typeof r.customerName).toBe("string");
    expect(typeof r.courseName).toBe("string");
    expect(typeof r.courseDurationMin).toBe("number");
    expect(typeof r.startAtISO).toBe("string");
    expect(typeof r.endAtISO).toBe("string");
    expect(r.status).toBe("confirmed");
    expect(r.manualSortOrder).toBeNull();
  });

  it("cancelled ステータスの予約は返さない", async () => {
    // Mark resId2 as cancelled temporarily
    await sql`update reservations set status = 'cancelled'::reservation_status where id = ${resId2}::uuid`;
    try {
      const result = await getReservationList(resDate);
      const found = result.find((r) => r.id === resId2);
      expect(found).toBeUndefined();
    } finally {
      await sql`update reservations set status = 'confirmed'::reservation_status where id = ${resId2}::uuid`;
    }
  });
});

describe("reorderReservations", () => {
  it("orderedIds の順に manual_sort_order を保存し、再取得で反映される", async () => {
    // Set order: resId2 first, resId1 second (reverse of start_at order)
    await reorderReservations({ dateISO: resDate, orderedIds: [resId2, resId1] });

    const result = await getReservationList(resDate);
    const r1 = result.find((x) => x.id === resId1)!;
    const r2 = result.find((x) => x.id === resId2)!;
    expect(r2.manualSortOrder).toBe(0);
    expect(r1.manualSortOrder).toBe(1);
  });

  it("manual_sort_order でソートされるため並び順が反転する", async () => {
    // resId2 は manual_sort_order=0, resId1 は 1 → resId2 が先
    const result = await getReservationList(resDate);
    const ours = result.filter((r) => r.id === resId1 || r.id === resId2);
    expect(ours[0]!.id).toBe(resId2);
    expect(ours[1]!.id).toBe(resId1);
  });
});
