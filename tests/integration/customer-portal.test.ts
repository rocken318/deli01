import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getCustomerPortal } from "@/lib/customer-portal/queries";

/**
 * 顧客ポータル（マジックリンク / 0027）の実Postgres検証。自己完結。
 * security definer 関数 customer_portal_summary がトークンで本人の要約だけ返すこと、
 * 無効トークンは null、他人のトークンで他人のデータが漏れないことを確認。
 */
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });

const PHONE = "0" + String(Date.now()).slice(-10);
const SLUG = "ztest-portal";
let custId = "";
let token = "";
let otherToken = "";

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`
    insert into therapists (slug, status, display_order) values (${SLUG}, 'active', 9300)
    on conflict (slug) do update set status='active' returning id`;
  const therapistId = t[0]!.id;
  await sql`
    insert into entity_records (entity, slug, draft, published, published_at)
    values ('therapist', ${SLUG}, ${sql.json({ name: "ポータル子" })}, ${sql.json({ name: "ポータル子" })}, now())
    on conflict (entity, slug) do update set draft = excluded.draft`;

  const c = await sql<{ id: string; portal_token: string }[]>`
    insert into customers (phone, name, cached_points)
    values (${PHONE}, 'ポータル太郎', 250)
    on conflict (phone) do update set name = excluded.name, cached_points = 250
    returning id, portal_token`;
  custId = c[0]!.id;
  token = c[0]!.portal_token;

  const other = await sql<{ portal_token: string }[]>`
    insert into customers (phone, name, cached_points)
    values (${"0" + String(Date.now() + 1).slice(-10)}, '別人', 999)
    on conflict (phone) do nothing returning portal_token`;
  const o = await sql<{ portal_token: string }[]>`select portal_token from customers where name='別人' limit 1`;
  otherToken = (other[0]?.portal_token ?? o[0]?.portal_token)!;

  const [area] = await sql<{ id: string }[]>`select id from areas where is_active=true limit 1`;
  const [course] = await sql<{ id: string }[]>`select id, duration_min from courses order by duration_min limit 1`;
  const [addr] = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id)
    values (${custId}::uuid, 'home', 'テスト住所', ${area!.id}::uuid) returning id`;
  const start = new Date("2026-09-01T05:00:00Z");
  await sql`
    insert into reservations (therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min,
      status, nomination_fee, transport_fee, total_amount, source, done_at)
    values (${therapistId}::uuid, ${custId}::uuid, ${addr!.id}::uuid, ${area!.id}::uuid, ${course!.id}::uuid,
      ${start}, ${new Date(start.getTime() + 3600000)}, ${new Date(start.getTime() - 1500000)}, ${new Date(start.getTime() + 4200000)},
      15, 15, 30, 'done'::reservation_status, 0, 0, 13000, 'phone'::reservation_source, ${new Date(start.getTime() + 3600000)})`;
});

afterAll(async () => {
  await sql`delete from reservations where customer_id = ${custId}`;
  await sql`delete from addresses where customer_id = ${custId}`;
  await sql`delete from customers where phone = ${PHONE} or name = '別人'`;
  await sql`delete from entity_records where entity='therapist' and slug = ${SLUG}`;
  await sql`delete from therapists where slug = ${SLUG}`;
  await sql.end();
});

describe("customer portal（マジックリンク・security definer）", () => {
  it("有効トークンで本人の名前・ポイント・履歴を返す", async () => {
    const p = await getCustomerPortal(token);
    expect(p).toBeTruthy();
    expect(p!.name).toBe("ポータル太郎");
    expect(p!.points).toBe(250);
    expect(p!.history.length).toBeGreaterThanOrEqual(1);
    expect(p!.history[0]!.therapist).toBe("ポータル子");
    expect(p!.history[0]!.therapistSlug).toBe(SLUG);
  });

  it("無効トークンは null", async () => {
    expect(await getCustomerPortal("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await getCustomerPortal("not-a-uuid")).toBeNull();
  });

  it("他人のトークンでは自分の履歴（別人）が返り、太郎の履歴は混ざらない", async () => {
    const p = await getCustomerPortal(otherToken);
    expect(p).toBeTruthy();
    expect(p!.name).toBe("別人");
    // 別人には reservation を作っていない＝履歴は空（太郎の分が漏れない）
    expect(p!.history.length).toBe(0);
  });
});
