import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";

// revalidatePath はリクエストコンテキスト外だと動かないため no-op 化
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  listTaxiCompanies,
  createTaxiCompany,
  updateTaxiCompany,
  deleteTaxiCompany,
  listDriverMessages,
  postDriverMessage,
  deleteDriverMessage,
} from "@/lib/dispatch-roster/actions";
import { getDispatchBoardCore } from "@/lib/dispatch-board/queries";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

/**
 * dispatch-ops 統合テスト（0025 / spec 7-1 配車運用レイヤー）。
 *
 * 検証内容:
 * 1. taxi_companies: CRUD（owner session）
 * 2. taxi_companies: RLS（reception は select 可・write 不可）
 * 3. driver_messages: 投稿・一覧・削除
 * 4. room_number: getDispatchBoardCore で roomNumber フィールドが返る
 *
 * 前提: pnpm db:migrate 適用済み（0025_dispatch_ops.sql）。db:reset/seed はしない。
 * 命名: ztest- プレフィックスで他テストの後に実行。自己完結（afterAll でクリーンアップ）。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const TZ = "Asia/Tokyo";

// seed 固定 UUID（ztest-dispatch-fields.test.ts に倣う）
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";

const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

const TEST_PHONE = "0905555" + String(Date.now()).slice(-4);

const taxiIds: string[] = [];
const msgIds: string[] = [];
let aoiId: string;
let customerId: string;
let addressId: string;
const resIds: string[] = [];

let slotCounter = 0;
function nextOffset(): number {
  const offset = 5000 + slotCounter * 200;
  slotCounter += 1;
  return offset;
}

async function insertReservationWithRoom(
  startOffsetMin: number,
  roomNumber: string | null,
): Promise<string> {
  const id = randomUUID();
  const startMs = Date.now() + startOffsetMin * 60_000;
  const start = new Date(startMs);
  const end = new Date(startMs + 60 * 60_000);
  const depart = new Date(startMs - 20 * 60_000);
  const free = new Date(startMs + 80 * 60_000);

  await sql`
    insert into reservations (
      id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min, status, total_amount,
      room_number
    ) values (
      ${id}::uuid,
      ${aoiId}::uuid,
      ${customerId}::uuid,
      ${addressId}::uuid,
      (select id from areas limit 1),
      (select id from courses limit 1),
      ${start}, ${end}, ${depart}, ${free},
      15, 15, 5,
      'confirmed'::reservation_status,
      10000,
      ${roomNumber}
    )
    on conflict (id) do nothing
  `;
  resIds.push(id);
  return id;
}

beforeAll(async () => {
  const therapists = await sql<{ id: string }[]>`
    select id from therapists where slug = 'aoi' limit 1
  `;
  aoiId = therapists[0]?.id ?? "";
  if (!aoiId) throw new Error("seed に aoi が見つかりません。pnpm db:seed を確認してください");

  const cRows = await sql<{ id: string }[]>`
    insert into customers (phone, name)
    values (${TEST_PHONE}, 'dispatch-ops統合テスト顧客')
    on conflict (phone) do update set name = excluded.name
    returning id
  `;
  customerId = cRows[0]!.id;

  const aRows = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id, label)
    values (
      ${customerId}::uuid, 'home', 'dispatch-opsテスト住所',
      (select id from areas limit 1),
      'テストラベル'
    )
    returning id
  `;
  addressId = aRows[0]!.id;
});

afterAll(async () => {
  if (taxiIds.length > 0) {
    await sql`delete from taxi_companies where id = any(${taxiIds}::uuid[])`;
  }
  if (msgIds.length > 0) {
    await sql`delete from driver_messages where id = any(${msgIds}::uuid[])`;
  }
  if (resIds.length > 0) {
    await sql`delete from reservations where id = any(${resIds}::uuid[])`;
  }
  await sql`delete from addresses where id = ${addressId}::uuid`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

// =====================================================================
// 1. taxi_companies: CRUD
// =====================================================================
describe("taxi_companies: CRUD（owner session = ADMIN_DEV_SESSION）", () => {
  it("taxi_company を作成できる", async () => {
    const r = await createTaxiCompany({
      name: "テストタクシー株式会社",
      phone: "0901234567",
      shiftNote: "平日9-21時",
      note: "NG: 大型車不可",
      sortOrder: 1,
      isActive: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    taxiIds.push(r.data!.id);
  });

  it("listTaxiCompanies で作成した会社が取得できる", async () => {
    const r = await listTaxiCompanies();
    expect(r.ok).toBe(true);
    const found = r.data?.find((t) => t.name === "テストタクシー株式会社");
    expect(found).toBeDefined();
    expect(found?.phone).toBe("0901234567");
    expect(found?.shiftNote).toBe("平日9-21時");
  });

  it("taxi_company を更新できる", async () => {
    const id = taxiIds[0]!;
    const r = await updateTaxiCompany({ id, name: "更新後タクシー", isActive: false });
    expect(r.ok).toBe(true);

    const list = await listTaxiCompanies();
    const found = list.data?.find((t) => t.id === id);
    expect(found?.name).toBe("更新後タクシー");
    expect(found?.isActive).toBe(false);
  });

  it("taxi_company を削除できる", async () => {
    const id = taxiIds.pop()!;
    const r = await deleteTaxiCompany(id);
    expect(r.ok).toBe(true);

    const list = await listTaxiCompanies();
    const found = list.data?.find((t) => t.id === id);
    expect(found).toBeUndefined();
  });
});

// =====================================================================
// 2. taxi_companies: RLS（reception は select 可・write 不可）
// =====================================================================
describe("taxi_companies: RLS", () => {
  let testTaxiId: string;

  beforeAll(async () => {
    // owner セッション（ADMIN_DEV_SESSION）で作成
    const r = await createTaxiCompany({ name: "RLSテスト会社", sortOrder: 99, isActive: true });
    expect(r.ok).toBe(true);
    testTaxiId = r.data!.id;
    taxiIds.push(testTaxiId);
  });

  it("reception セッションは taxi_companies を SELECT できる", async () => {
    const rows = await withUser(sql, receptionSession, async (tx) => {
      return tx<{ id: string }[]>`
        select id from taxi_companies where id = ${testTaxiId}::uuid
      `;
    });
    expect(rows.length).toBe(1);
  });

  it("reception セッションは taxi_companies を DELETE できない（RLS 拒否: 0行）", async () => {
    // PostgreSQL RLS の USING 句による保護: reception には対象行が見えないため
    // DELETE は例外ではなく 0行削除で完了する（これが正しい RLS の動作）
    const result = await withUser(sql, receptionSession, async (tx) => {
      return tx`delete from taxi_companies where id = ${testTaxiId}::uuid returning id`;
    });
    // 0 件 = RLS がブロック済み。まだテーブルに残っていること
    expect(result).toHaveLength(0);
    const rows = await sql`select id from taxi_companies where id = ${testTaxiId}::uuid`;
    expect(rows).toHaveLength(1);
  });
});

// =====================================================================
// 3. driver_messages: 投稿・一覧・削除
// =====================================================================
describe("driver_messages: 投稿・一覧・削除", () => {
  it("伝言を投稿できる", async () => {
    const r = await postDriverMessage({ body: "統合テスト: 本日○○エリア渋滞注意" });
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    msgIds.push(r.data!.id);
  });

  it("listDriverMessages で投稿した伝言が取得できる", async () => {
    const r = await listDriverMessages(10);
    expect(r.ok).toBe(true);
    const found = r.data?.find((m) => m.body === "統合テスト: 本日○○エリア渋滞注意");
    expect(found).toBeDefined();
  });

  it("伝言を削除できる", async () => {
    const id = msgIds.pop()!;
    const r = await deleteDriverMessage(id);
    expect(r.ok).toBe(true);

    const list = await listDriverMessages(10);
    const found = list.data?.find((m) => m.id === id);
    expect(found).toBeUndefined();
  });
});

// =====================================================================
// 4. room_number: getDispatchBoardCore で roomNumber フィールドが返る
// =====================================================================
describe("getDispatchBoardCore: roomNumber フィールドの確認", () => {
  let resIdWithRoom: string;
  let resIdNoRoom: string;
  let resDate: string;

  beforeAll(async () => {
    resIdWithRoom = await insertReservationWithRoom(nextOffset(), "1234号室");
    resIdNoRoom = await insertReservationWithRoom(nextOffset(), null);

    const row = await sql<{ start_at: Date }[]>`
      select start_at from reservations where id = ${resIdWithRoom}::uuid
    `;
    resDate = formatInTimeZone(row[0]!.start_at, TZ, "yyyy-MM-dd");
  });

  it("roomNumber フィールドが DispatchBoardItem に存在する", async () => {
    const outcome = await getDispatchBoardCore(sql, receptionSession, resDate);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    const item = outcome.items.find((i) => i.reservationId === resIdWithRoom);
    expect(item).toBeDefined();
    if (!item) return;

    expect(Object.keys(item)).toContain("roomNumber");
  });

  it("room_number に設定した値が roomNumber として返る", async () => {
    const outcome = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (outcome.kind !== "ok") return;

    const item = outcome.items.find((i) => i.reservationId === resIdWithRoom);
    if (!item) return;

    expect(item.roomNumber).toBe("1234号室");
  });

  it("room_number が null の予約では roomNumber が null を返す", async () => {
    const outcome = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (outcome.kind !== "ok") return;

    const item = outcome.items.find((i) => i.reservationId === resIdNoRoom);
    if (!item) return;

    expect(item.roomNumber).toBeNull();
  });
});

