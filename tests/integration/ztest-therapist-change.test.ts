import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const mockAuth = vi.hoisted(() => ({ session: null as { userId: string; role: string } | null }));
vi.mock("@/lib/cms/dev-session", () => ({
  getDevSession: async () => mockAuth.session,
}));

import {
  listAssignableTherapists,
  changeReservationTherapist,
} from "@/lib/reservations/therapist-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let aoiId: string, minatoId: string;
let customerId: string;
let res1Id: string;
let aoiExtraId: string | null = null;

const TEST_PHONE = "0907777" + String(Date.now()).slice(-4);

// Each reservation: start at +720min, depart=start-20min, free=start+80min
// Window: [+700min, +800min]
// Uses 'held' status to avoid reservations_customer_required_check (which requires
// address_id for confirmed/done/enroute/in_service)
async function insertReservation(
  therapistId: string,
  offsetMin: number,
): Promise<string> {
  const id = randomUUID();
  const startMs = Date.now() + offsetMin * 60_000;
  const start = new Date(startMs);
  const end = new Date(startMs + 60 * 60_000); // 60min service
  const depart = new Date(startMs - 20 * 60_000); // 20min before
  const free = new Date(startMs + 80 * 60_000);   // 80min after start
  await sql`
    insert into reservations (
      id, therapist_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min, status, total_amount
    ) values (
      ${id}::uuid, ${therapistId}::uuid,
      (select id from areas limit 1), (select id from courses limit 1),
      ${start}, ${end}, ${depart}, ${free}, 20, 15, 5,
      'held'::reservation_status, 10000
    ) on conflict (id) do nothing`;
  return id;
}

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;
  minatoId = (await sql<{ id: string }[]>`select id from therapists where slug='minato' limit 1`)[0]!.id;
  // customer is needed only for the 'done' test case
  customerId = (await sql<{ id: string }[]>`
    insert into customers (phone, name)
    values (${TEST_PHONE}, '担当変更テスト顧客')
    on conflict (phone) do update set name = excluded.name
    returning id`)[0]!.id;

  // Set up mock session (owner role)
  const ownerRow = await sql<{ id: string }[]>`
    select id from app_users where role = 'owner' limit 1`;
  mockAuth.session = { userId: ownerRow[0]!.id, role: 'owner' };

  // Create res1 assigned to aoi at +720min (window [+700, +800])
  res1Id = await insertReservation(aoiId, 720);
});

afterAll(async () => {
  if (aoiExtraId) {
    await sql`delete from reservations where id = ${aoiExtraId}::uuid`;
  }
  await sql`delete from reservations where id = ${res1Id}::uuid`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("listAssignableTherapists", () => {
  it("res1（aoi担当）の場合：aoi は自分の予約なので busy=false、minato は重複なし busy=false", async () => {
    const result = await listAssignableTherapists(res1Id);
    expect(result.ok).toBe(true);
    const list = result.data!;
    const aoi = list.find((t) => t.id === aoiId);
    const minato = list.find((t) => t.id === minatoId);
    expect(aoi).toBeDefined();
    expect(minato).toBeDefined();
    // res1 is excluded from overlap check, so aoi has no other reservations at this time
    expect(aoi!.busy).toBe(false);
    expect(minato!.busy).toBe(false);
  });
});

describe("changeReservationTherapist", () => {
  it("res1 を aoi から minato に変更できる", async () => {
    const result = await changeReservationTherapist({
      reservationId: res1Id,
      therapistId: minatoId,
    });
    expect(result.ok).toBe(true);
    expect(result.data?.version).toBeGreaterThan(0);

    // Verify DB
    const rows = await sql<{ therapist_id: string }[]>`
      select therapist_id from reservations where id = ${res1Id}::uuid`;
    expect(rows[0]!.therapist_id).toBe(minatoId);
  });

  it("変更後：aoi に別予約（aoi_extra）を追加すると aoi.busy=true になる", async () => {
    // Create aoi_extra at same time (+720min) now that res1 is minato's
    aoiExtraId = await insertReservation(aoiId, 720);

    const result = await listAssignableTherapists(res1Id);
    expect(result.ok).toBe(true);
    const list = result.data!;
    const aoi = list.find((t) => t.id === aoiId);
    const minato = list.find((t) => t.id === minatoId);
    // aoi has aoi_extra at same window (excluding res1 which is minato's)
    expect(aoi!.busy).toBe(true);
    // minato has res1 but it's excluded, so not busy from other reservations
    expect(minato!.busy).toBe(false);
  });

  it("aoi が busy な時間に res1 を aoi へ変更しようとすると DB exclusion 制約で失敗する", async () => {
    // aoi has aoiExtra at [+700,+800], res1 is also at [+700,+800] for minato
    // Changing res1 to aoi would conflict with aoi_extra
    const result = await changeReservationTherapist({
      reservationId: res1Id,
      therapistId: aoiId,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('別の予約');
  });

  it("完了済み予約は担当を変更できない", async () => {
    // Insert a done reservation: needs customer_id + address_id (DB constraint)
    const doneId = randomUUID();
    const startMs = Date.now() + 900 * 60_000;
    const start = new Date(startMs);
    const end = new Date(startMs + 60 * 60_000);
    const depart = new Date(startMs - 20 * 60_000);
    const free = new Date(startMs + 80 * 60_000);

    // Create address for this customer
    const addrRows = await sql<{ id: string }[]>`
      insert into addresses (customer_id, kind, detail, area_id)
      values (${customerId}::uuid, 'home'::address_kind, 'テスト住所', (select id from areas limit 1))
      returning id`;
    const addressId = addrRows[0]!.id;

    await sql`
      insert into reservations (
        id, therapist_id, customer_id, address_id, area_id, course_id,
        start_at, end_at, depart_at, free_at,
        travel_in_min, travel_out_min, buffer_min, status, total_amount
      ) values (
        ${doneId}::uuid, ${aoiId}::uuid, ${customerId}::uuid, ${addressId}::uuid,
        (select id from areas limit 1), (select id from courses limit 1),
        ${start}, ${end}, ${depart}, ${free}, 20, 15, 5,
        'done'::reservation_status, 10000
      )`;

    const result = await changeReservationTherapist({
      reservationId: doneId,
      therapistId: minatoId,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('完了/取消済みの予約は担当を変更できません');

    // cleanup
    await sql`delete from reservations where id = ${doneId}::uuid`;
    await sql`delete from addresses where id = ${addressId}::uuid`;
  });
});
