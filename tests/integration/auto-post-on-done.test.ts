import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { shiftInstants } from "@/domain/availability";
import { formatInTimeZone } from "date-fns-tz";

// advanceReservationStatus は revalidatePath を呼ぶ（リクエスト外）ためモック
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { advanceReservationStatus } from "@/lib/dispatch-board/actions";

/**
 * 完了時の会計自動計上（発注者確定 2026-09-03）: advanceReservationStatus で done に
 * 到達したら revenue_lines / payout_lines が自動で作られることを検証（実Postgres・
 * ADMIN_DEV_SESSION=1 で owner スタブ）。冪等（再度 done 相当でも二重計上しない）。
 */
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });
const TZ = "Asia/Tokyo";
const SLUG = "ztest-autopost";
const RES_ID = "d00e0000-0000-4000-8000-0000000000a1";
let therapistId = "";

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`
    insert into therapists (slug, status, display_order) values (${SLUG}, 'active', 9400)
    on conflict (slug) do update set status='active' returning id`;
  therapistId = t[0]!.id;
  await sql`
    insert into entity_records (entity, slug, draft, published, published_at)
    values ('therapist', ${SLUG}, ${sql.json({ name: "自動計上テスト" })}, ${sql.json({ name: "自動計上テスト" })}, now())
    on conflict (entity, slug) do update set draft = excluded.draft`;
  const [area] = await sql<{ id: string }[]>`select id from areas where is_active=true limit 1`;
  const [course] = await sql<{ id: string; duration_min: number }[]>`select id, duration_min from courses order by duration_min limit 1`;
  const [cust] = await sql<{ id: string; address_id: string }[]>`
    select c.id, a.id as address_id from customers c join addresses a on a.customer_id=c.id and a.kind='home' limit 1`;
  const wd = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
  const { startAt } = shiftInstants(wd, "04:00", "04:00"); // 早朝の非重複帯
  const endAt = new Date(startAt.getTime() + 60 * 60_000);
  const departAt = new Date(startAt.getTime() - 25 * 60_000);
  const freeAt = new Date(endAt.getTime() + 10 * 60_000);
  await sql`
    insert into reservations (id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min,
      status, nomination_fee, transport_fee, total_amount, source,
      enroute_at, arrived_at, service_started_at)
    values (${RES_ID}::uuid, ${therapistId}::uuid, ${cust!.id}::uuid, ${cust!.address_id}::uuid, ${area!.id}::uuid, ${course!.id}::uuid,
      ${startAt}, ${endAt}, ${departAt}, ${freeAt}, 15, 15, 30,
      'in_service'::reservation_status, 0, 0, 13000, 'phone'::reservation_source,
      ${departAt}, ${startAt}, ${startAt})
    on conflict (id) do nothing`;
});

afterAll(async () => {
  await sql`delete from revenue_lines where reservation_id = ${RES_ID}`;
  await sql`delete from payout_lines where reservation_id = ${RES_ID}`;
  await sql`delete from reservations where id = ${RES_ID}`;
  await sql`delete from entity_records where entity='therapist' and slug=${SLUG}`;
  await sql`delete from therapists where id=${therapistId}`;
  await sql.end();
});

describe("完了時の会計自動計上", () => {
  it("in_service→done で revenue_lines / payout_lines が自動作成される", async () => {
    const r = await advanceReservationStatus(RES_ID, "done");
    expect(r.ok).toBe(true);

    const rev = await sql<{ n: number }[]>`select count(*)::int as n from revenue_lines where reservation_id=${RES_ID}`;
    const pay = await sql<{ n: number }[]>`select count(*)::int as n from payout_lines where reservation_id=${RES_ID}`;
    expect(rev[0]!.n).toBeGreaterThan(0);
    expect(pay[0]!.n).toBeGreaterThan(0);
  });
});
