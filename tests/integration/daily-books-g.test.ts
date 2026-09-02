import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { Session } from "@/lib/auth/session";
import { getDailyBooksCore } from "@/lib/accounting/daily-books";
import { businessDayRange } from "@/domain/accounting";

/**
 * G 日次会計コアの実Postgres検証（自己完結）。
 * 営業日 06:00 JST 境界を確認: 深夜 02:00 開始（翌暦日）は前営業日に計上、
 * 早朝 03:00 開始（境界前）は当営業日には入らない。売上/バック/経費/粗利・個人別を検証。
 */
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });
const OWNER: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "owner" };

const SLUG = "ztest-books";
const D = "2026-09-02"; // 営業日 = [09-02 06:00, 09-03 06:00) JST
let therapistId = "";
let areaId = "";
let courseId = "";
let custId = "";
let addressId = "";

// 09-03 02:00 JST（= 前営業日 09-02 に入る） / 09-02 03:00 JST（= 境界前・営業日 09-01）
const IN_RANGE = new Date("2026-09-02T17:00:00Z");
const BEFORE_RANGE = new Date("2026-09-01T18:00:00Z");

async function makeReservation(id: string, startAt: Date, total: number) {
  const endAt = new Date(startAt.getTime() + 60 * 60_000);
  const departAt = new Date(startAt.getTime() - 25 * 60_000);
  const freeAt = new Date(endAt.getTime() + 10 * 60_000);
  await sql`
    insert into reservations (id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min,
      status, nomination_fee, transport_fee, total_amount, source, done_at)
    values (${id}::uuid, ${therapistId}::uuid, ${custId}::uuid, ${addressId}::uuid, ${areaId}::uuid, ${courseId}::uuid,
      ${startAt}, ${endAt}, ${departAt}, ${freeAt}, 15, 15, 30,
      'done'::reservation_status, 0, 0, ${total}, 'phone'::reservation_source, ${endAt})
    on conflict (id) do nothing`;
}

async function addRevenue(resId: string, amount: number, occurredAt: Date) {
  await sql`
    insert into revenue_lines (reservation_id, line_type, amount, area_id, therapist_id, occurred_at, created_by)
    values (${resId}::uuid, 'course'::revenue_line_type, ${amount}, ${areaId}::uuid, ${therapistId}::uuid, ${occurredAt}, ${OWNER.userId}::uuid)`;
}

async function addPayout(resId: string, amount: number, businessDate: string) {
  await sql`
    insert into payout_lines (therapist_id, business_date, reservation_id, category, amount, calc_note, created_by)
    values (${therapistId}::uuid, ${businessDate}::date, ${resId}::uuid, 'course'::payout_category, ${amount},
      ${sql.json({ formula: "test" })}, ${OWNER.userId}::uuid)`;
}

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`
    insert into therapists (slug, status, display_order) values (${SLUG}, 'active', 9100)
    on conflict (slug) do update set status = 'active' returning id`;
  therapistId = t[0]!.id;
  await sql`
    insert into entity_records (entity, slug, draft, published, published_at)
    values ('therapist', ${SLUG}, ${sql.json({ name: "会計テスト" })}, ${sql.json({ name: "会計テスト" })}, now())
    on conflict (entity, slug) do update set draft = excluded.draft`;
  const [area] = await sql<{ id: string }[]>`select id from areas where is_active = true limit 1`;
  const [course] = await sql<{ id: string }[]>`select id from courses order by duration_min limit 1`;
  const [cust] = await sql<{ id: string; address_id: string }[]>`
    select c.id, a.id as address_id from customers c join addresses a on a.customer_id = c.id and a.kind = 'home' limit 1`;
  areaId = area!.id;
  courseId = course!.id;
  custId = cust!.id;
  addressId = cust!.address_id;

  const inId = "b00c0000-0000-4000-8000-000000000001";
  const beforeId = "b00c0000-0000-4000-8000-000000000002";
  await makeReservation(inId, IN_RANGE, 13000);
  await makeReservation(beforeId, BEFORE_RANGE, 9000);
  // 営業日 D に入る予約: 売上13000・バック5000
  await addRevenue(inId, 13000, IN_RANGE);
  await addPayout(inId, 5000, "2026-09-03"); // business_date は暦日だが予約 start_at 境界で D に入る
  // 境界前の予約: D の集計に入ってはいけない
  await addRevenue(beforeId, 9000, BEFORE_RANGE);
  await addPayout(beforeId, 4000, "2026-09-02");
  // 経費（spent_on = 営業日 D）
  await sql`
    insert into expenses (category, amount, spent_on, created_by)
    values ('oil'::expense_category, 2000, ${D}::date, ${OWNER.userId}::uuid)`;
});

afterAll(async () => {
  if (therapistId) {
    await sql`delete from revenue_lines where therapist_id = ${therapistId}`;
    await sql`delete from payout_lines where therapist_id = ${therapistId}`;
    await sql`delete from reservations where therapist_id = ${therapistId}`;
    await sql`delete from entity_records where entity = 'therapist' and slug = ${SLUG}`;
    await sql`delete from therapists where id = ${therapistId}`;
  }
  await sql`delete from expenses where spent_on = ${D}::date and amount = 2000 and category = 'oil'`;
  await sql.end();
});

describe("getDailyBooksCore（G 日次会計・営業日境界）", () => {
  it("深夜02:00分は前営業日Dに計上・境界前03:00分は除外", async () => {
    const range = businessDayRange(D, "day");
    const r = await getDailyBooksCore(sql, OWNER, range);
    const row = r.byTherapist.find((t) => t.therapistId === therapistId);
    expect(row).toBeTruthy();
    // D に入るのは IN_RANGE の1件のみ（13000売上・5000バック）
    expect(row!.revenue).toBe(13000);
    expect(row!.payout).toBe(5000);
    expect(row!.storeShare).toBe(8000);
    expect(row!.reservationCount).toBe(1);
  });

  it("店舗合計: 粗利 = 売上 − バック − 経費（このセラピスト分を含む）", async () => {
    const range = businessDayRange(D, "day");
    const r = await getDailyBooksCore(sql, OWNER, range);
    // 少なくともこのテストの寄与分が反映されている（他シードと混ざらないよう差分で確認）
    expect(r.storeTotal.revenue).toBeGreaterThanOrEqual(13000);
    expect(r.storeTotal.expenses).toBeGreaterThanOrEqual(2000);
    expect(r.storeTotal.grossProfit).toBe(
      r.storeTotal.revenue - r.storeTotal.payout - r.storeTotal.expenses,
    );
  });
});
