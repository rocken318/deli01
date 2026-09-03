import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { shiftInstants } from "@/domain/availability";
import { listAnnaiBoardCore } from "@/lib/annai/queries";
import { buildBoard } from "@/domain/annai";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });
const OWNER: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "owner" };

// 他テスト・デモに依存しない自作セラピスト（当日の予約を自前で作る）
const SLUG = "ztest-annai";
const TZ = "Asia/Tokyo";
// 決定的にするため「今日20:00 JST」を board の now とする（営業日=今日・06:00境界内）
const TODAY = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
const [ty, tm, td] = TODAY.split("-").map(Number);
const TOMORROW = new Date(Date.UTC(ty!, tm! - 1, td! + 1)).toISOString().slice(0, 10);
const NOW = shiftInstants(TODAY, "20:00", "20:00").startAt.getTime();
const DURATION = 60;
let therapistId = "";

const DONE1 = "a11a0000-0000-4000-8000-000000001600"; // 16:00 done
const DONE2 = "a11a0000-0000-4000-8000-000000001800"; // 18:00 done
const UP = "a11a0000-0000-4000-8000-000000002200"; // 22:00 confirmed（未来）
const LATE = "a11a0000-0000-4000-8000-000000002500"; // 翌01:00（=25:00）confirmed（日跨ぎ）

async function makeRes(rid: string, startAt: Date, status: "done" | "confirmed", refs: {
  areaId: string; courseId: string; custId: string; addressId: string;
}) {
  const endAt = new Date(startAt.getTime() + DURATION * 60_000);
  const departAt = new Date(startAt.getTime() - 25 * 60_000);
  const freeAt = new Date(endAt.getTime() + 10 * 60_000);
  if (status === "done") {
    await sql`
      insert into reservations (id, therapist_id, customer_id, address_id, area_id, course_id,
        start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min,
        status, nomination_fee, transport_fee, total_amount, source,
        enroute_at, arrived_at, service_started_at, done_at)
      values (${rid}::uuid, ${therapistId}::uuid, ${refs.custId}::uuid, ${refs.addressId}::uuid, ${refs.areaId}::uuid, ${refs.courseId}::uuid,
        ${startAt}, ${endAt}, ${departAt}, ${freeAt}, 15, 15, 30,
        'done'::reservation_status, 0, 0, 13000, 'phone'::reservation_source,
        ${departAt}, ${startAt}, ${startAt}, ${endAt})
      on conflict (id) do nothing`;
  } else {
    await sql`
      insert into reservations (id, therapist_id, customer_id, address_id, area_id, course_id,
        start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min,
        status, nomination_fee, transport_fee, total_amount, source, phone_confirmed_at, phone_confirmed_by)
      values (${rid}::uuid, ${therapistId}::uuid, ${refs.custId}::uuid, ${refs.addressId}::uuid, ${refs.areaId}::uuid, ${refs.courseId}::uuid,
        ${startAt}, ${endAt}, ${departAt}, ${freeAt}, 15, 15, 30,
        'confirmed'::reservation_status, 0, 0, 13000, 'phone'::reservation_source, ${startAt}, ${OWNER.userId}::uuid)
      on conflict (id) do nothing`;
  }
}

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`
    insert into therapists (slug, status, display_order) values (${SLUG}, 'active', 9000)
    on conflict (slug) do update set status = 'active' returning id`;
  therapistId = t[0]!.id;
  await sql`
    insert into entity_records (entity, slug, draft, published, published_at)
    values ('therapist', ${SLUG}, ${sql.json({ name: "案内テスト" })}, ${sql.json({ name: "案内テスト" })}, now())
    on conflict (entity, slug) do update set draft = excluded.draft`;
  const [area] = await sql<{ id: string }[]>`select id from areas where is_active = true limit 1`;
  const [course] = await sql<{ id: string }[]>`select id from courses order by duration_min limit 1`;
  const [cust] = await sql<{ id: string; address_id: string }[]>`
    select c.id, a.id as address_id from customers c join addresses a on a.customer_id = c.id and a.kind = 'home' limit 1`;
  const refs = { areaId: area!.id, courseId: course!.id, custId: cust!.id, addressId: cust!.address_id };
  // 今日16:00/18:00 done（過去）、22:00 confirmed（未来）、翌01:00=25:00 confirmed（日跨ぎ）
  await makeRes(DONE1, shiftInstants(TODAY, "16:00", "16:00").startAt, "done", refs);
  await makeRes(DONE2, shiftInstants(TODAY, "18:00", "18:00").startAt, "done", refs);
  await makeRes(UP, shiftInstants(TODAY, "22:00", "22:00").startAt, "confirmed", refs);
  await makeRes(LATE, shiftInstants(TOMORROW, "01:00", "01:00").startAt, "confirmed", refs);
});

afterAll(async () => {
  if (therapistId) {
    await sql`delete from reservations where therapist_id = ${therapistId}`;
    await sql`delete from entity_records where entity = 'therapist' and slug = ${SLUG}`;
    await sql`delete from therapists where id = ${therapistId}`;
  }
  await sql.end();
});

describe("annai board (実Postgres・自己完結)", () => {
  it("done×2（過去）/ upcoming×2（未来22時＋日跨ぎ25時）を集約し working", async () => {
    const rows = await withUser(sql, OWNER, (tx) => listAnnaiBoardCore(tx, NOW));
    const t = rows.find((r) => r.slug === SLUG);
    expect(t).toBeTruthy();
    expect(t!.done.length).toBe(2);
    expect(t!.upcoming.length).toBe(2);
    expect(t!.attendanceState).toBe("working");
  });

  it("日跨ぎ: 翌01:00（25時）の予約も当営業日の板（これから）に含まれる", async () => {
    const rows = await withUser(sql, OWNER, (tx) => listAnnaiBoardCore(tx, NOW));
    const t = rows.find((r) => r.slug === SLUG)!;
    const late = t.upcoming.find((j) => j.id === LATE);
    expect(late).toBeTruthy();
    // start_at は翌暦日
    expect(formatInTimeZone(late!.startAt, TZ, "yyyy-MM-dd")).toBe(TOMORROW);
  });

  it("done 予約の清算状態(reconciledAt)を集約する", async () => {
    await sql`
      update reservations set reconciled_at = now(), collected_amount = 13000, reconciled_by = ${OWNER.userId}::uuid
      where id = ${DONE1}::uuid`;
    const rows = await withUser(sql, OWNER, (tx) => listAnnaiBoardCore(tx, NOW));
    const t = rows.find((r) => r.slug === SLUG)!;
    const settled = t.done.filter((j) => j.reconciledAt !== null);
    const unsettled = t.done.filter((j) => j.reconciledAt === null);
    expect(settled.length).toBe(1);
    expect(unsettled.length).toBe(1);
  });

  it("buildBoard が落ちず、行は名前・slug・状態を持つ", async () => {
    const rows = await withUser(sql, OWNER, (tx) => listAnnaiBoardCore(tx, NOW));
    const { active, retired } = buildBoard(rows, NOW);
    expect(Array.isArray(active)).toBe(true);
    expect(Array.isArray(retired)).toBe(true);
    for (const r of rows) {
      expect(typeof r.slug).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(["off", "working", "done"]).toContain(r.attendanceState);
    }
  });
});
