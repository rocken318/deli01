import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { fromZonedTime } from "date-fns-tz";
import type { Session } from "@/lib/auth/session";
import { getServiceHistoryAdmin } from "@/lib/admin/service-history";
import { getMyServiceHistoryCore } from "@/lib/dispatch-board/mypage-schedule";

/**
 * 接客履歴の scope 検証（実 Postgres）: 管理=全員 / セラピスト=自分のみ。
 * done 予約を aoi に1件作り、管理は見える・aoi本人は見える・ren本人は見えないことを確認。
 * 前提: ADMIN_DEV_SESSION=1（getServiceHistoryAdmin の getDevSession が owner）。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const enabled = process.env.ADMIN_DEV_SESSION === "1";
const RID = "abcd0000-0000-4000-8000-00000000f001";
const sessions = new Map<string, Session>();

beforeAll(async () => {
  const rows = await sql<{ user_id: string; therapist_id: string; slug: string }[]>`
    select au.id as user_id, au.therapist_id, t.slug
    from app_users au join therapists t on t.id = au.therapist_id
    where t.slug in ('aoi', 'ren')
  `;
  for (const r of rows) {
    sessions.set(r.slug, { userId: r.user_id, role: "therapist", therapistId: r.therapist_id });
  }
  // aoi に done 予約を1件作る（既存の顧客/住所/コース/エリアを流用）
  const start = fromZonedTime("2025-06-15T13:00:00", "Asia/Tokyo");
  const end = fromZonedTime("2025-06-15T14:00:00", "Asia/Tokyo");
  await sql`
    insert into reservations (
      id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min,
      status, nomination_fee, transport_fee, total_amount, source, done_at
    )
    select ${RID}::uuid, t.id, c.id, a.id, ar.id, co.id,
      ${start}, ${end}, ${start}, ${end}, 15, 15, 30,
      'done'::reservation_status, 0, 0, 12000, 'phone'::reservation_source, ${end}
    from therapists t
    join customers c on true
    join addresses a on a.customer_id = c.id and a.kind='home'
    join areas ar on ar.name = '国分町'
    join courses co on true
    where t.slug = 'aoi'
    order by c.created_at, co.duration_min
    limit 1
    on conflict (id) do nothing
  `;
});

afterAll(async () => {
  await sql`delete from reservations where id = ${RID}::uuid`;
  await sql.end({ timeout: 5 });
});

describe.skipIf(!enabled)("接客履歴 scope（管理=全員 / 本人=自分のみ）", () => {
  it("管理(getServiceHistoryAdmin)は done を全員分見られる", async () => {
    const outcome = await getServiceHistoryAdmin({ limit: 200 });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.rows.some((r) => r.reservationId === RID)).toBe(true);
  });

  it("管理は therapist で絞り込める", async () => {
    const outcome = await getServiceHistoryAdmin({ therapistSlug: "aoi", limit: 200 });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.rows.every((r) => r.therapistSlug === "aoi")).toBe(true);
  });

  it("aoi 本人は自分の done を見られる", async () => {
    const outcome = await getMyServiceHistoryCore(sql, sessions.get("aoi")!);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.items.some((i) => i.reservationId === RID)).toBe(true);
  });

  it("ren 本人には aoi の接客が見えない（RLS 本人限定）", async () => {
    const outcome = await getMyServiceHistoryCore(sql, sessions.get("ren")!);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.items.some((i) => i.reservationId === RID)).toBe(false);
  });
});
