import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { recordEntryCallCore, settleReservationCore } from "@/lib/annai/checkpoint-queries";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });
const OWNER: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "owner" };
const REN: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000005", role: "therapist" };

const SLUG = "ztest-p2";
const RID = "b2b20000-0000-4000-8000-000000000001";
const TOTAL = 26400;
const NOW = Date.now();
let therapistId = "";

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`
    insert into therapists (slug, status, display_order) values (${SLUG}, 'active', 9100)
    on conflict (slug) do update set status='active' returning id`;
  therapistId = t[0]!.id;
  const [area] = await sql<{ id: string }[]>`select id from areas where is_active=true limit 1`;
  const [course] = await sql<{ id: string; duration_min: number }[]>`select id, duration_min from courses order by duration_min limit 1`;
  const [cust] = await sql<{ id: string; address_id: string }[]>`
    select c.id, a.id as address_id from customers c join addresses a on a.customer_id=c.id and a.kind='home' limit 1`;
  const start = new Date(Date.UTC(2029, 5, 1, 3, 0, 0)); // 未来日・他テスト非衝突
  const end = new Date(start.getTime() + course!.duration_min * 60000);
  await sql`
    insert into reservations (id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min,
      status, nomination_fee, transport_fee, total_amount, source,
      enroute_at, arrived_at, service_started_at, done_at)
    values (${RID}::uuid, ${therapistId}::uuid, ${cust!.id}::uuid, ${cust!.address_id}::uuid, ${area!.id}::uuid, ${course!.id}::uuid,
      ${start}, ${end}, ${start}, ${end}, 15, 15, 30,
      'done'::reservation_status, 0, 0, ${TOTAL}, 'phone'::reservation_source,
      ${start}, ${start}, ${start}, ${end})
    on conflict (id) do nothing`;
});

afterAll(async () => {
  await sql`delete from audit_logs where entity='reservation' and entity_id=${RID}`;
  await sql`delete from reservations where id = ${RID}::uuid`;
  await sql`delete from therapists where slug = ${SLUG}`;
  await sql.end();
});

describe("annai checkpoints/settle (実Postgres)", () => {
  it("入室電話は set-once（2回目は null）", async () => {
    const r1 = await withUser(sql, OWNER, (tx) => recordEntryCallCore(tx, RID, NOW));
    expect(r1?.entryCallAt).not.toBeNull();
    const r2 = await withUser(sql, OWNER, (tx) => recordEntryCallCore(tx, RID, NOW));
    expect(r2).toBeNull();
  });

  it("差額ありでメモ無し → note_required", async () => {
    const out = await withUser(sql, OWNER, (tx) => settleReservationCore(tx, RID, TOTAL - 800, true, "", OWNER.userId, NOW));
    expect(out.kind).toBe("note_required");
  });

  it("RLS: therapist は他人の予約を清算できない（not_settleable）", async () => {
    const out = await withUser(sql, REN, (tx) => settleReservationCore(tx, RID, TOTAL, false, "", REN.userId, NOW));
    expect(out.kind).toBe("not_settleable");
  });

  it("差額ありでメモあり → ok・差額-800・カード・reconciled_by・監査追記", async () => {
    const out = await withUser(sql, OWNER, (tx) => settleReservationCore(tx, RID, TOTAL - 800, true, "つり銭不足", OWNER.userId, NOW));
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.data.diff).toBe(-800);
    const row = await sql<{ is_card_payment: boolean; reconciled_by: string | null; settle_note: string | null }[]>`
      select is_card_payment, reconciled_by, settle_note from reservations where id = ${RID}::uuid`;
    expect(row[0]!.is_card_payment).toBe(true);
    expect(row[0]!.reconciled_by).toBe(OWNER.userId);
    expect(row[0]!.settle_note).toBe("つり銭不足");
    const audit = await sql<{ c: number }[]>`select count(*)::int c from audit_logs where entity='reservation' and entity_id=${RID} and action='settle'`;
    expect(audit[0]!.c).toBeGreaterThanOrEqual(1);
  });

  it("再清算は拒否（not_settleable）", async () => {
    const out = await withUser(sql, OWNER, (tx) => settleReservationCore(tx, RID, TOTAL, false, "", OWNER.userId, NOW));
    expect(out.kind).toBe("not_settleable");
  });
});
