import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const mockAuth = vi.hoisted(() => ({ session: null as { userId: string; role: string } | null }));
vi.mock("@/lib/cms/dev-session", () => ({
  getDevSession: async () => mockAuth.session,
}));

import { changeReservationHotel } from "@/lib/reservations/hotel-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

/** 固定タイムスタンプ（テストは常に同じ時刻 2026-09-12T10:00:00+09:00） */
const FIXED_NOW = new Date("2026-09-12T01:00:00.000Z"); // JST 10:00
const START_MS = FIXED_NOW.getTime() + 120 * 60_000; // +2h from fixed now

let therapistId: string;
let areaIdA: string;   // area with transport_fee = 2000
let areaIdB: string;   // area with transport_fee = 4000
let hotelIdA: string;  // hotel in area A, no hotel-specific fee → uses area A = 2000
let hotelIdB: string;  // hotel in area B, hotel-specific fee = 5000
let hotelIdC: string;  // hotel in area B, no hotel-specific fee → uses area B = 4000
let hotelIdBlocked: string; // blocked hotel
let resId: string;

async function insertTestReservation(opts: {
  hotelId: string;
  areaId: string;
  transportFee: number;
  totalAmount: number;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  const start = new Date(START_MS);
  const end = new Date(START_MS + 60 * 60_000);
  const depart = new Date(START_MS - 20 * 60_000);
  const free = new Date(START_MS + 80 * 60_000);
  const status = opts.status ?? "held";
  await sql`
    insert into reservations (
      id, therapist_id, hotel_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min, status,
      transport_fee, total_amount
    ) values (
      ${id}::uuid, ${therapistId}::uuid,
      ${opts.hotelId}::uuid,
      ${opts.areaId}::uuid,
      (select id from courses limit 1),
      ${start}, ${end}, ${depart}, ${free},
      20, 15, 5, ${status}::reservation_status,
      ${opts.transportFee}, ${opts.totalAmount}
    ) on conflict (id) do nothing
  `;
  return id;
}

beforeAll(async () => {
  // Setup mock session
  const ownerRow = await sql<{ id: string }[]>`
    select id from app_users where role = 'owner' limit 1`;
  mockAuth.session = { userId: ownerRow[0]!.id, role: "owner" };

  // Get a therapist
  therapistId = (await sql<{ id: string }[]>`select id from therapists limit 1`)[0]!.id;

  // Create two test areas with distinct transport fees
  const areasInserted = await sql<{ id: string }[]>`
    insert into areas (name, kind, transport_fee, is_active)
    values ('テストエリアA_hotel_change', 'ward', 2000, true),
           ('テストエリアB_hotel_change', 'ward', 4000, true)
    returning id
  `;
  areaIdA = areasInserted[0]!.id;
  areaIdB = areasInserted[1]!.id;

  // Create test hotels
  // hotelIdA: in area A, no hotel-specific fee
  hotelIdA = (await sql<{ id: string }[]>`
    insert into hotels (name, area_id, transport_fee, is_blocked)
    values ('テストホテルA_hotel_change', ${areaIdA}::uuid, null, false)
    returning id
  `)[0]!.id;

  // hotelIdB: in area B, hotel-specific fee = 5000
  hotelIdB = (await sql<{ id: string }[]>`
    insert into hotels (name, area_id, transport_fee, is_blocked)
    values ('テストホテルB_hotel_change', ${areaIdB}::uuid, 5000, false)
    returning id
  `)[0]!.id;

  // hotelIdC: in area B, no hotel-specific fee → uses area B = 4000
  hotelIdC = (await sql<{ id: string }[]>`
    insert into hotels (name, area_id, transport_fee, is_blocked)
    values ('テストホテルC_hotel_change', ${areaIdB}::uuid, null, false)
    returning id
  `)[0]!.id;

  // hotelIdBlocked
  hotelIdBlocked = (await sql<{ id: string }[]>`
    insert into hotels (name, area_id, transport_fee, is_blocked)
    values ('テストホテルBlocked_hotel_change', ${areaIdA}::uuid, null, true)
    returning id
  `)[0]!.id;

  // Create a base reservation: hotel A (fee=2000), total=27000
  resId = await insertTestReservation({
    hotelId: hotelIdA,
    areaId: areaIdA,
    transportFee: 2000,
    totalAmount: 27000,
  });
});

afterAll(async () => {
  // Clean up test data (guard undefined in case beforeAll failed)
  if (resId) await sql`delete from reservations where id = ${resId}::uuid`;
  await sql`delete from hotels where name like '%_hotel_change'`;
  await sql`delete from areas where name like '%_hotel_change'`;
  await sql.end({ timeout: 5 });
});

describe("changeReservationHotel", () => {
  it("ホテルA(fee=2000)→ホテルB(fee=5000): transport_fee と total_amount が差分更新される", async () => {
    const result = await changeReservationHotel({ reservationId: resId, hotelId: hotelIdB });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data!.oldFee).toBe(2000);
    expect(result.data!.newFee).toBe(5000);
    expect(result.data!.newTotal).toBe(27000 - 2000 + 5000); // 30000
    expect(result.data!.areaChanged).toBe(true); // A→B

    // Verify DB
    const rows = await sql<{ hotel_id: string; area_id: string; transport_fee: number; total_amount: number }[]>`
      select hotel_id, area_id, transport_fee, total_amount from reservations where id = ${resId}::uuid`;
    expect(rows[0]!.hotel_id).toBe(hotelIdB);
    expect(rows[0]!.area_id).toBe(areaIdB);
    expect(Number(rows[0]!.transport_fee)).toBe(5000);
    expect(Number(rows[0]!.total_amount)).toBe(30000);
  });

  it("ホテルB(fee=5000)→ホテルC(エリアB, fee=4000): hotel-fee fallback=area_fee が使われる", async () => {
    // resId is now: hotel=B, area=B, transport_fee=5000, total=30000
    const result = await changeReservationHotel({ reservationId: resId, hotelId: hotelIdC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data!.oldFee).toBe(5000);
    expect(result.data!.newFee).toBe(4000); // area B's fee
    expect(result.data!.newTotal).toBe(30000 - 5000 + 4000); // 29000
    expect(result.data!.areaChanged).toBe(false); // stays in B
  });

  it("blockedホテルへの変更は拒否される", async () => {
    const result = await changeReservationHotel({ reservationId: resId, hotelId: hotelIdBlocked });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("受け入れ停止");
  });

  it("done状態の予約は変更できない", async () => {
    // Create a done reservation (needs customer + address per DB constraints)
    const customerId = (await sql<{ id: string }[]>`
      insert into customers (phone, name)
      values ('09012349876', 'ホテル変更テスト')
      on conflict (phone) do update set name = excluded.name
      returning id
    `)[0]!.id;
    const addressId = (await sql<{ id: string }[]>`
      insert into addresses (customer_id, kind, detail, area_id)
      values (${customerId}::uuid, 'home'::address_kind, 'テスト', ${areaIdA}::uuid)
      returning id
    `)[0]!.id;

    const start = new Date(START_MS + 200 * 60_000);
    const end = new Date(start.getTime() + 60 * 60_000);
    const depart = new Date(start.getTime() - 20 * 60_000);
    const free = new Date(start.getTime() + 80 * 60_000);
    const doneId = randomUUID();
    await sql`
      insert into reservations (
        id, therapist_id, customer_id, address_id, hotel_id, area_id, course_id,
        start_at, end_at, depart_at, free_at,
        travel_in_min, travel_out_min, buffer_min, status,
        transport_fee, total_amount
      ) values (
        ${doneId}::uuid, ${therapistId}::uuid,
        ${customerId}::uuid, ${addressId}::uuid,
        ${hotelIdA}::uuid, ${areaIdA}::uuid,
        (select id from courses limit 1),
        ${start}, ${end}, ${depart}, ${free},
        20, 15, 5, 'done'::reservation_status,
        2000, 27000
      )
    `;

    const result = await changeReservationHotel({ reservationId: doneId, hotelId: hotelIdB });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("完了/取消済みの予約は変更できません");

    // cleanup
    await sql`delete from reservations where id = ${doneId}::uuid`;
    await sql`delete from addresses where id = ${addressId}::uuid`;
    await sql`delete from customers where id = ${customerId}::uuid`;
  });

  it("audit_logs に before/after が記録される", async () => {
    // resId is now: hotel=C, area=B, transport_fee=4000, total=29000
    // Confirm audit log from first change (hotel A→B)
    const logs = await sql<{ before: unknown; after: unknown }[]>`
      select before, after from audit_logs
      where entity = 'reservation' and entity_id = ${resId}::uuid
        and action = 'hotel_change'
      order by occurred_at desc
      limit 5
    `;
    // Should have at least 2 hotel_change logs (A→B, B→C)
    expect(logs.length).toBeGreaterThanOrEqual(2);
    // Most recent: B→C
    const latest = logs[0]!;
    expect((latest.after as { newFee?: number }).newFee).toBe(4000);
  });
});
