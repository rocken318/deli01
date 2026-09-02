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
const NOW = Date.now();
const WD = formatInTimeZone(new Date(NOW), TZ, "yyyy-MM-dd");
let therapistId = "";

async function makeRes(h: number, status: "done" | "confirmed", refs: {
  areaId: string;
  courseId: string;
  custId: string;
  addressId: string;
  duration: number;
}) {
  const start = `${String(h).padStart(2, "0")}:00`;
  const { startAt } = shiftInstants(WD, start, start);
  const startMs = startAt.getTime();
  const endAt = new Date(startMs + refs.duration * 60_000);
  const departAt = new Date(startMs - 25 * 60_000);
  const freeAt = new Date(endAt.getTime() + 10 * 60_000);
  const rid = `a11a0000-0000-4000-8000-${String(h).padStart(12, "0")}`;
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
        status, nomination_fee, transport_fee, total_amount, source,
        phone_confirmed_at, phone_confirmed_by)
      values (${rid}::uuid, ${therapistId}::uuid, ${refs.custId}::uuid, ${refs.addressId}::uuid, ${refs.areaId}::uuid, ${refs.courseId}::uuid,
        ${startAt}, ${endAt}, ${departAt}, ${freeAt}, 15, 15, 30,
        'confirmed'::reservation_status, 0, 0, 13000, 'phone'::reservation_source,
        ${startAt}, ${OWNER.userId}::uuid)
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
  const [course] = await sql<{ id: string; duration_min: number }[]>`select id, duration_min from courses order by duration_min limit 1`;
  const [cust] = await sql<{ id: string; address_id: string }[]>`
    select c.id, a.id as address_id from customers c join addresses a on a.customer_id = c.id and a.kind = 'home' limit 1`;
  const refs = { areaId: area!.id, courseId: course!.id, custId: cust!.id, addressId: cust!.address_id, duration: course!.duration_min };
  // 早朝の非重複スロット（他テストと衝突しない・自作therapistなので占有も独立）
  await makeRes(3, "done", refs);
  await makeRes(5, "done", refs);
  await makeRes(8, "confirmed", refs);
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
  it("当日 done×2 / upcoming×1 を集約し、状態は working", async () => {
    const rows = await withUser(sql, OWNER, (tx) => listAnnaiBoardCore(tx, NOW));
    const t = rows.find((r) => r.slug === SLUG);
    expect(t).toBeTruthy();
    expect(t!.done.length).toBe(2);
    expect(t!.upcoming.length).toBe(1);
    expect(t!.attendanceState).toBe("working");
  });

  it("done 予約の清算状態(reconciledAt)を集約する（✔会計済インジケータの土台）", async () => {
    // 3時の done を清算済みに、5時の done は未清算のまま
    await sql`
      update reservations set reconciled_at = now(), collected_amount = 13000, reconciled_by = ${OWNER.userId}::uuid
      where id = ${`a11a0000-0000-4000-8000-${String(3).padStart(12, "0")}`}::uuid`;
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
