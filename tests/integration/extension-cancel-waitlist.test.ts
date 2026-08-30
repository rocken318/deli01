import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { addSameDayExtension } from "@/lib/booking/extension-actions";
import { cancelReservation } from "@/lib/booking/cancel-actions";
import { registerWaitlist, listWaitlists } from "@/lib/booking/waitlist-actions";

/**
 * フェーズ15 統合テスト（実 Postgres 必須）。
 *
 * 完了条件「後続に間に合わない延長が拒否される」（受入 L1100）を実データで実証する。
 * あわせてキャンセルで枠が空くこと・キャンセル待ち登録を検証。
 *
 * 前提: pnpm db:reset 済み。ADMIN_DEV_SESSION=1（getDevSession が owner を返す）。
 * 予約は superuser 経路で直接挿入（RLS 素通り）。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let therapistId = "";
let courseId = "";
let areaId = "";
let optionId = "";
let optionDuration = 0;
let optionPrice = 0;
let customerId = "";
let addressId = "";

const resIds: string[] = [];
const waitlistIds: string[] = [];
const TEST_PHONE = "0903333" + String(Date.now()).slice(-4);

async function insertReservation(opts: {
  startOffsetMin: number;
  durationMin?: number;
  status?: string;
  totalAmount?: number;
}): Promise<{ id: string; start: Date; free: Date }> {
  const id = randomUUID();
  const durationMin = opts.durationMin ?? 60;
  const status = opts.status ?? "confirmed";
  const startMs = Date.now() + opts.startOffsetMin * 60_000;
  const start = new Date(startMs);
  const end = new Date(startMs + durationMin * 60_000);
  const depart = new Date(startMs - 20 * 60_000);
  const free = new Date(startMs + (durationMin + 20) * 60_000);
  await sql`
    insert into reservations (
      id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min, status, total_amount
    ) values (
      ${id}::uuid, ${therapistId}::uuid, ${customerId}::uuid, ${addressId}::uuid,
      ${areaId}::uuid, ${courseId}::uuid,
      ${start}, ${end}, ${depart}, ${free}, 20, 20, 30,
      ${status}::reservation_status, ${opts.totalAmount ?? 12000}
    )
  `;
  resIds.push(id);
  return { id, start, free };
}

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`select id from therapists where slug = 'ren' limit 1`;
  therapistId = t[0]!.id;
  const c = await sql<{ id: string }[]>`select id from courses where is_active order by sort_order limit 1`;
  courseId = c[0]!.id;
  const a = await sql<{ id: string }[]>`select id from areas order by sort_order limit 1`;
  areaId = a[0]!.id;
  // 延長用オプション: 時間>0・対応制限（option_availability）が無い＝全員可のもの
  const o = await sql<{ id: string; duration_min: number; price: number }[]>`
    select o.id, o.duration_min, o.price
    from options o
    where o.is_active and o.is_public and o.duration_min > 0
      and not exists (select 1 from option_availability oa where oa.option_id = o.id)
    order by o.duration_min desc
    limit 1
  `;
  optionId = o[0]!.id;
  optionDuration = o[0]!.duration_min;
  optionPrice = o[0]!.price;

  const cust = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${TEST_PHONE}, 'phase15顧客')
    on conflict (phone) do update set name = excluded.name
    returning id
  `;
  customerId = cust[0]!.id;
  const addr = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id)
    values (${customerId}::uuid, 'home', 'phase15住所', ${areaId}::uuid)
    returning id
  `;
  addressId = addr[0]!.id;
});

afterAll(async () => {
  if (resIds.length > 0) {
    await sql`delete from reservation_options where reservation_id = any(${resIds}::uuid[])`;
    await sql`delete from reservations where id = any(${resIds}::uuid[])`;
  }
  if (waitlistIds.length > 0) {
    await sql`delete from waitlists where id = any(${waitlistIds}::uuid[])`;
  }
  await sql`delete from waitlists where phone = ${TEST_PHONE}`;
  if (addressId) await sql`delete from addresses where id = ${addressId}::uuid`;
  if (customerId) await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("addSameDayExtension – 当日延長の可否（完了条件・受入 L1100）", () => {
  it("後続予約が無ければ延長できる（占有と金額が伸びる）", async () => {
    // 12000 分後（他テストと分離）・後続なし
    const r = await insertReservation({ startOffsetMin: 12000, durationMin: 60, status: "in_service" });
    const before = await sql<{ free_at: Date; total_amount: number }[]>`
      select free_at, total_amount from reservations where id = ${r.id}::uuid
    `;

    const res = await addSameDayExtension(r.id, optionId);
    expect(res.ok).toBe(true);
    expect(res.data?.addedMinutes).toBe(optionDuration);

    const after = await sql<{ free_at: Date; total_amount: number }[]>`
      select free_at, total_amount from reservations where id = ${r.id}::uuid
    `;
    // free_at が optionDuration 分だけ後ろへ・金額が optionPrice 分だけ増える
    expect(after[0]!.free_at.getTime()).toBe(
      before[0]!.free_at.getTime() + optionDuration * 60_000,
    );
    expect(after[0]!.total_amount).toBe(before[0]!.total_amount + optionPrice);
    // reservation_options が1行増える
    const opts = await sql<{ n: number }[]>`
      select count(*)::int as n from reservation_options where reservation_id = ${r.id}::uuid
    `;
    expect(opts[0]!.n).toBe(1);
  });

  it("★ 後続予約に間に合わない延長は拒否され、オプションも追加されない（完了条件）", async () => {
    // current: start=13000, free = start+80分。next: depart = current.free に隣接。
    const cur = await insertReservation({ startOffsetMin: 13000, durationMin: 60, status: "in_service" });
    // next の start = current.start + 100分 → next.depart = current.start+80 = current.free（隣接）
    await insertReservation({ startOffsetMin: 13100, durationMin: 60, status: "confirmed" });

    const res = await addSameDayExtension(cur.id, optionId);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/後続/);

    // オプションは追加されていない
    const opts = await sql<{ n: number }[]>`
      select count(*)::int as n from reservation_options where reservation_id = ${cur.id}::uuid
    `;
    expect(opts[0]!.n).toBe(0);
    // 占有も伸びていない
    const after = await sql<{ free_at: Date }[]>`
      select free_at from reservations where id = ${cur.id}::uuid
    `;
    expect(after[0]!.free_at.getTime()).toBe(cur.free.getTime());
  });

  it("上書き（理由つき）でも物理的に重なる延長は二重予約を作らず拒否される", async () => {
    const cur = await insertReservation({ startOffsetMin: 14000, durationMin: 60, status: "in_service" });
    await insertReservation({ startOffsetMin: 14100, durationMin: 60, status: "confirmed" });

    const res = await addSameDayExtension(cur.id, optionId, { overrideReason: "承知で詰める" });
    expect(res.ok).toBe(false); // exclusion が物理重複を弾く
    const opts = await sql<{ n: number }[]>`
      select count(*)::int as n from reservation_options where reservation_id = ${cur.id}::uuid
    `;
    expect(opts[0]!.n).toBe(0);
  });
});

describe("cancelReservation – キャンセルで枠が空く / 料率", () => {
  it("キャンセルすると status=cancelled・cancelled_at 記録・枠が空く", async () => {
    const r = await insertReservation({ startOffsetMin: 15000, durationMin: 60, status: "confirmed" });
    const res = await cancelReservation(r.id, "customer", "顧客都合");
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe("cancelled");

    const row = await sql<{ status: string; cancelled_at: Date | null; cancel_kind: string | null }[]>`
      select status::text, cancelled_at, cancel_kind::text from reservations where id = ${r.id}::uuid
    `;
    expect(row[0]!.status).toBe("cancelled");
    expect(row[0]!.cancelled_at).not.toBeNull();
    expect(row[0]!.cancel_kind).toBe("customer");

    // 枠が空いた＝同時間帯に別予約を入れても exclusion に弾かれない
    const overlap = await insertReservation({ startOffsetMin: 15000, durationMin: 60, status: "confirmed" });
    const check = await sql<{ n: number }[]>`
      select count(*)::int as n from reservations where id = ${overlap.id}::uuid
    `;
    expect(check[0]!.n).toBe(1);
  });

  it("開始1時間前のキャンセルは 50%（既定雛形）", async () => {
    const r = await insertReservation({ startOffsetMin: 60, durationMin: 60, status: "confirmed", totalAmount: 12000 });
    const res = await cancelReservation(r.id, "customer", "直前キャンセル");
    expect(res.ok).toBe(true);
    expect(res.data?.feePercent).toBe(50);
    expect(res.data?.fee).toBe(6000);
  });

  it("noshow は全額・status=noshow", async () => {
    const r = await insertReservation({ startOffsetMin: 16000, durationMin: 60, status: "confirmed", totalAmount: 10000 });
    const res = await cancelReservation(r.id, "noshow", "無断");
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe("noshow");
    expect(res.data?.fee).toBe(10000);
  });
});

describe("registerWaitlist / listWaitlists – キャンセル待ち（枠は押さえない）", () => {
  it("登録できて staff 一覧に出る", async () => {
    const reg = await registerWaitlist({
      phone: TEST_PHONE,
      desiredDate: "2026-09-10",
      timeFrom: "18:00",
      timeTo: "21:00",
      note: "夜希望",
    });
    expect(reg.ok).toBe(true);
    if (reg.data) waitlistIds.push(reg.data.id);

    const list = await listWaitlists();
    expect(list.ok).toBe(true);
    expect(list.data?.some((w) => w.phone === TEST_PHONE)).toBe(true);

    // 枠（reservations/held）は作られていない
    const held = await sql<{ n: number }[]>`
      select count(*)::int as n from reservations where status = 'held' and area_id = ${areaId}::uuid
        and start_at::date = '2026-09-10'
    `;
    expect(held[0]!.n).toBe(0);
  });

  it("電話番号の形式が不正なら登録できない", async () => {
    const reg = await registerWaitlist({ phone: "abc", desiredDate: "2026-09-10" });
    expect(reg.ok).toBe(false);
  });
});
