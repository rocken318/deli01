import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  advanceReservationStatusCore,
  getDispatchBoardCore,
  getTherapistTimelineCore,
} from "@/lib/dispatch-board/queries";
import type { Session } from "@/lib/auth/session";
import { formatInTimeZone } from "date-fns-tz";

/**
 * フェーズ14 配車ボード・マイページ中核の統合テスト（実 Postgres）。
 *
 * 最小セット（網羅は qa フェーズ / 最終報告の観点リスト参照）:
 * 1. getTherapistTimelineCore: 本人の当日予定が返り、電話番号キーが存在せず、
 *    180分ゲート内の住所には audit_logs (view/address) が残る
 * 2. advanceReservationStatusCore: confirmed→enroute が version+1 で成功、
 *    スキップ遷移（enroute→done は可・enroute→enroute 等）は invalid_transition
 * 3. getDispatchBoardCore: staff は電話番号つきで取得でき、therapist は forbidden
 *
 * 前提: pnpm db:reset 済み（seed の app_users / therapists.aoi を使う）。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const THERAPIST_USER = "aaaaaaaa-0000-4000-8000-000000000004";
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const PHONE = "08099140001";

const RES_ID = "f1430000-0000-4000-8000-000000000001";

let aoiId: string;
let therapistSession: Session;
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

/** 今日（Asia/Tokyo）の "YYYY-MM-DD" */
const todayISO = formatInTimeZone(new Date(), "Asia/Tokyo", "yyyy-MM-dd");

beforeAll(async () => {
  aoiId = (
    await sql<{ id: string }[]>`select id from therapists where slug = 'aoi'`
  )[0]!.id;
  therapistSession = { userId: THERAPIST_USER, role: "therapist", therapistId: aoiId };

  const customer = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE}, '配車テスト顧客')
    on conflict (phone) do update set name = excluded.name
    returning id
  `;
  const address = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id)
    values (${customer[0]!.id}::uuid, 'home', '配車テスト住所',
            (select id from areas limit 1))
    returning id
  `;
  // 開始60分後（今日・180分ゲート内）。日跨ぎ直前の実行では当日境界を跨ぎ得るが、
  // テストは todayISO と startAt の両方を now 起点で組むため整合する
  const start = new Date(Date.now() + 60 * 60_000);
  await sql`
    insert into reservations (
      id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min, status, total_amount
    ) values (
      ${RES_ID}::uuid, ${aoiId}::uuid, ${customer[0]!.id}::uuid, ${address[0]!.id}::uuid,
      (select id from areas limit 1), (select id from courses limit 1),
      ${start}, ${new Date(start.getTime() + 60 * 60_000)},
      ${new Date(start.getTime() - 20 * 60_000)}, ${new Date(start.getTime() + 80 * 60_000)},
      15, 15, 5, 'confirmed', 10000
    )
    on conflict (id) do nothing
  `;
});

afterAll(async () => {
  await sql`delete from reservations where id = ${RES_ID}::uuid`;
  await sql`delete from addresses where detail = '配車テスト住所'`;
  await sql`delete from customers where phone = ${PHONE}`;
  await sql.end({ timeout: 5 });
});

describe("getTherapistTimelineCore（spec 7-4・13-3）", () => {
  it("本人の当日予定が返り、電話番号は含まれず、住所閲覧が監査される", async () => {
    const before = await sql<{ n: string }[]>`
      select count(*) as n from audit_logs
      where action = 'view' and entity = 'address'
        and actor_user_id = ${THERAPIST_USER}::uuid
    `;

    const outcome = await getTherapistTimelineCore(sql, therapistSession, todayISO);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    const item = outcome.items.find((i) => i.reservationId === RES_ID);
    expect(item).toBeDefined();
    // 180分ゲート内: 住所・顧客名が見える
    expect(item!.addressDetail).toBe("配車テスト住所");
    expect(item!.customerName).toBe("配車テスト顧客");
    // 電話番号は構造上返さない（キー自体が存在しない / spec 7-3）
    expect(JSON.stringify(outcome.items)).not.toContain(PHONE);
    expect(Object.keys(item!)).not.toContain("customerPhone");

    // 住所閲覧の監査（spec 13-3）
    const after = await sql<{ n: string }[]>`
      select count(*) as n from audit_logs
      where action = 'view' and entity = 'address'
        and actor_user_id = ${THERAPIST_USER}::uuid
    `;
    expect(Number(after[0]!.n)).toBeGreaterThan(Number(before[0]!.n));
  });

  it("staff セッションは forbidden（電話番号の経路を混ぜない）", async () => {
    const outcome = await getTherapistTimelineCore(sql, receptionSession, todayISO);
    expect(outcome.kind).toBe("forbidden");
  });
});

describe("advanceReservationStatusCore（spec 7-1 ワンタップ前進）", () => {
  it("therapist 本人が confirmed→enroute に進められる（version+1・enroute_at 記録）", async () => {
    const outcome = await advanceReservationStatusCore(
      sql,
      therapistSession,
      RES_ID,
      "enroute",
    );
    expect(outcome).toMatchObject({ kind: "ok", version: 1 });
    const row = await sql<{ status: string; enroute_at: Date | null }[]>`
      select status::text, enroute_at from reservations where id = ${RES_ID}::uuid
    `;
    expect(row[0]!.status).toBe("enroute");
    expect(row[0]!.enroute_at).not.toBeNull();
  });

  it("スキップ遷移（enroute→done）は invalid_transition", async () => {
    const outcome = await advanceReservationStatusCore(
      sql,
      therapistSession,
      RES_ID,
      "done",
    );
    expect(outcome.kind).toBe("invalid_transition");
  });
});

describe("getDispatchBoardCore（spec 7-1 staff 専用）", () => {
  it("reception は電話番号つきで当日ボードを取得できる", async () => {
    const outcome = await getDispatchBoardCore(sql, receptionSession, todayISO);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const item = outcome.items.find((i) => i.reservationId === RES_ID);
    expect(item).toBeDefined();
    expect(item!.customerPhone).toBe(PHONE);
    expect(item!.firstVisit).toBe(true);
  });

  it("therapist は forbidden", async () => {
    const outcome = await getDispatchBoardCore(sql, therapistSession, todayISO);
    expect(outcome.kind).toBe("forbidden");
  });
});
