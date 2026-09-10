import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  assignLegDriver, setLegState, clearLegDriver, finishReservation, getDispatchLegs,
} from "@/lib/dispatch-board/leg-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let aoiId: string, driverId: string, resId: string, resDate: string;
let customerId: string, addressId: string;

const TEST_PHONE = "0906666" + String(Date.now()).slice(-4);

async function insertReservation(offsetMin: number): Promise<string> {
  const id = randomUUID();
  const startMs = Date.now() + offsetMin * 60_000;
  const start = new Date(startMs), end = new Date(startMs + 3_600_000);
  const depart = new Date(startMs - 1_200_000), free = new Date(startMs + 4_800_000);
  await sql`
    insert into reservations (
      id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min, status, total_amount
    ) values (
      ${id}::uuid, ${aoiId}::uuid, ${customerId}::uuid, ${addressId}::uuid,
      (select id from areas limit 1), (select id from courses limit 1),
      ${start}, ${end}, ${depart}, ${free}, 15, 15, 5, 'confirmed'::reservation_status, 10000
    ) on conflict (id) do nothing`;
  return id;
}

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;
  customerId = (await sql<{ id: string }[]>`
    insert into customers (phone, name)
    values (${TEST_PHONE}, '脚テスト顧客')
    on conflict (phone) do update set name = excluded.name
    returning id`)[0]!.id;
  addressId = (await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id, label)
    values (${customerId}::uuid, 'home', '脚テスト住所', (select id from areas limit 1), '脚テスト')
    returning id`)[0]!.id;
  driverId = (await sql<{ id: string }[]>`
    insert into drivers (name, vehicle_color_hex, vehicle_color_name, vehicle_number)
    values ('脚テスト運転手','#2B2B2B','黒','6417') returning id`)[0]!.id;
  resId = await insertReservation(120);
  resDate = formatInTimeZone(
    (await sql<{ start_at: Date }[]>`select start_at from reservations where id=${resId}::uuid`)[0]!.start_at,
    "Asia/Tokyo", "yyyy-MM-dd");
});

afterAll(async () => {
  await sql`delete from dispatch_legs where reservation_id = ${resId}::uuid`;
  await sql`delete from reservations where id = ${resId}::uuid`;
  await sql`delete from drivers where id = ${driverId}::uuid`;
  await sql`delete from addresses where id = ${addressId}::uuid`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("assignLegDriver / getDispatchLegs", () => {
  it("送り脚にドライバーを割当（state=予定）", async () => {
    const r = await assignLegDriver({ reservationId: resId, slot: "send", driverId });
    expect(r.ok).toBe(true);
    const legs = await getDispatchLegs(resDate);
    const row = legs.data?.find((x) => x.reservationId === resId);
    expect(row?.send?.driverId).toBe(driverId);
    expect(row?.send?.state).toBe("予定");
    expect(row?.send?.vehicleColorHex).toBe("#2B2B2B");
  });

  it("再割当は上書き＋state初期化", async () => {
    await setLegState({
      legId: (await getDispatchLegs(resDate)).data!.find((x) => x.reservationId === resId)!.send!.id,
      slot: "send", state: "合流確認中",
    });
    await assignLegDriver({ reservationId: resId, slot: "send", driverId });
    const legs = await getDispatchLegs(resDate);
    expect(legs.data?.find((x) => x.reservationId === resId)?.send?.state).toBe("予定");
  });
});

describe("setLegState 検証", () => {
  it("帰り脚に送り状態はエラー", async () => {
    await assignLegDriver({ reservationId: resId, slot: "return", driverId });
    const legId = (await getDispatchLegs(resDate)).data!.find((x) => x.reservationId === resId)!.return!.id;
    const bad = await setLegState({ legId, slot: "return", state: "合流確認中" });
    expect(bad.ok).toBe(false);
    const good = await setLegState({ legId, slot: "return", state: "アウト待ち" });
    expect(good.ok).toBe(true);
  });
});

describe("finishReservation", () => {
  it("全脚完了で終了→includeFinished=false で消える", async () => {
    const legs = (await getDispatchLegs(resDate)).data!.find((x) => x.reservationId === resId)!;
    await setLegState({ legId: legs.send!.id, slot: "send", state: "完了" });
    await setLegState({ legId: legs.return!.id, slot: "return", state: "完了" });
    const fin = await finishReservation({ reservationId: resId });
    expect(fin.ok).toBe(true);
    const hidden = await getDispatchLegs(resDate);
    expect(hidden.data?.find((x) => x.reservationId === resId)).toBeUndefined();
    const shown = await getDispatchLegs(resDate, true);
    expect(shown.data?.find((x) => x.reservationId === resId)?.allFinished).toBe(true);
  });
});

describe("clearLegDriver", () => {
  it("割当解除で driverId が null", async () => {
    // 最初の予約（+120分〜free+80分）と重ならない時間帯（no_therapist_overlap 排他制約）
    const res2 = await insertReservation(360);
    const res2Date = formatInTimeZone(
      (await sql<{ start_at: Date }[]>`select start_at from reservations where id=${res2}::uuid`)[0]!.start_at,
      "Asia/Tokyo", "yyyy-MM-dd");
    await assignLegDriver({ reservationId: res2, slot: "send", driverId });
    const legId = (await getDispatchLegs(res2Date, true)).data!.find((x) => x.reservationId === res2)!.send!.id;
    const r = await clearLegDriver({ legId });
    expect(r.ok).toBe(true);
    const after = (await getDispatchLegs(res2Date, true)).data!.find((x) => x.reservationId === res2);
    expect(after?.send?.driverId ?? null).toBeNull();
    await sql`delete from dispatch_legs where reservation_id = ${res2}::uuid`;
    await sql`delete from reservations where id = ${res2}::uuid`;
  });
});
