import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { setReservationDispatchNeeds } from "@/lib/dispatch-board/needs-actions";
import { getDispatchBoardCore } from "@/lib/dispatch-board/queries";
import type { Session } from "@/lib/auth/session";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });
const receptionSession: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000003", role: "reception" };

let aoiId: string, customerId: string, addressId: string, resId: string, resDate: string;
const PHONE = "0906666" + String(Date.now()).slice(-4);

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;
  customerId = (await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE}, '車要否テスト') returning id`)[0]!.id;
  addressId = (await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id, label)
    values (${customerId}::uuid, 'home', '住所', (select id from areas limit 1), 'ラベル') returning id`)[0]!.id;
  const id = randomUUID();
  const start = new Date(Date.now() + 240 * 60_000);
  await sql`
    insert into reservations (id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min, status, total_amount)
    values (${id}::uuid, ${aoiId}::uuid, ${customerId}::uuid, ${addressId}::uuid,
      (select id from areas limit 1), (select id from courses limit 1),
      ${start}, ${new Date(start.getTime()+3_600_000)}, ${new Date(start.getTime()-1_200_000)},
      ${new Date(start.getTime()+4_800_000)}, 15, 15, 5, 'confirmed'::reservation_status, 10000)`;
  resId = id;
  resDate = formatInTimeZone(start, "Asia/Tokyo", "yyyy-MM-dd");
});

afterAll(async () => {
  await sql`delete from reservations where id = ${resId}::uuid`;
  await sql`delete from addresses where id = ${addressId}::uuid`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("車要否フラグ", () => {
  it("既定は送り/帰り両方 true（board が返す）", async () => {
    const out = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (out.kind !== "ok") throw new Error("forbidden");
    const item = out.items.find((i) => i.reservationId === resId)!;
    expect(item.needsSendCar).toBe(true);
    expect(item.needsReturnCar).toBe(true);
  });

  it("帰りだけ false に更新できる", async () => {
    const r = await setReservationDispatchNeeds({ reservationId: resId, needsSendCar: true, needsReturnCar: false });
    expect(r.ok).toBe(true);
    const out = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (out.kind !== "ok") throw new Error("forbidden");
    const item = out.items.find((i) => i.reservationId === resId)!;
    expect(item.needsSendCar).toBe(true);
    expect(item.needsReturnCar).toBe(false);
  });

  it("両方 false も可（配車不要）", async () => {
    const r = await setReservationDispatchNeeds({ reservationId: resId, needsSendCar: false, needsReturnCar: false });
    expect(r.ok).toBe(true);
    const out = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (out.kind !== "ok") throw new Error("forbidden");
    const item = out.items.find((i) => i.reservationId === resId)!;
    expect(item.needsSendCar).toBe(false);
    expect(item.needsReturnCar).toBe(false);
  });
});
