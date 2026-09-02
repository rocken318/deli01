import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";
import { getDispatchBoardCore, updateDispatchFieldsCore } from "@/lib/dispatch-board/queries";
import type { Session } from "@/lib/auth/session";

/**
 * dispatch_driver / dispatch_memo フィールドの統合テスト（0024 / spec 7-1 配車ボード）。
 *
 * 検証内容:
 * 1. getDispatchBoardCore が dispatch_driver / dispatch_memo を返す
 * 2. updateDispatchFieldsCore がドライバーを更新し、再取得で反映される
 * 3. updateDispatchFieldsCore がメモを更新し、再取得で反映される
 * 4. driver と memo を同時に更新できる
 * 5. forbidden: therapist には更新させない
 * 6. not_found: 存在しない UUID は not_found を返す
 * 7. 既存の dispatch-board テストが壊れていないこと（getDispatchBoardCore が
 *    DispatchBoardItem の型を正しく返すこと）
 *
 * 前提: pnpm db:migrate 適用済み（0024_dispatch_fields.sql で列が存在すること）。
 * db:reset/seed はしない。自分のデータのみ作成し afterAll で削除する。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const TZ = "Asia/Tokyo";

// seed 固定 UUID（dispatch-board-phase14.test.ts に倣う）
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const THERAPIST_AOI_USER = "aaaaaaaa-0000-4000-8000-000000000004";

const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

// テスト用電話番号（seed と衝突しないよう Date.now サフィックス）
const TEST_PHONE = "0904444" + String(Date.now()).slice(-4);

let aoiId: string;
let aoiSession: Session;
let customerId: string;
let addressId: string;
const resIds: string[] = [];

// 当日（JST）を使う
const todayISO = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");

// スロットカウンタ: 3000分後から開始し200分ずつ前進
// （3000分後 ≒ 50時間後 = 他テストの「600分+200分刻み」と十分に離れた未来）
let slotCounter = 0;
function nextOffset(): number {
  const offset = 3000 + slotCounter * 200;
  slotCounter += 1;
  return offset;
}

// =====================================================================
// ヘルパ: 予約を直接挿入（RLS 素通り経路）
// =====================================================================
async function insertReservation(startOffsetMin: number): Promise<string> {
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
      travel_in_min, travel_out_min, buffer_min, status, total_amount
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
      10000
    )
    on conflict (id) do nothing
  `;
  resIds.push(id);
  return id;
}

// =====================================================================
// セットアップ
// =====================================================================
beforeAll(async () => {
  const therapists = await sql<{ id: string; slug: string }[]>`
    select id, slug from therapists where slug = 'aoi' limit 1
  `;
  aoiId = therapists[0]?.id ?? "";
  if (!aoiId) throw new Error("seed に aoi が見つかりません。pnpm db:seed を確認してください");

  aoiSession = { userId: THERAPIST_AOI_USER, role: "therapist", therapistId: aoiId };

  const cRows = await sql<{ id: string }[]>`
    insert into customers (phone, name)
    values (${TEST_PHONE}, 'dispatch-fields統合テスト顧客')
    on conflict (phone) do update set name = excluded.name
    returning id
  `;
  customerId = cRows[0]!.id;

  const aRows = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id, label)
    values (
      ${customerId}::uuid, 'home', 'dispatchFieldsテスト住所',
      (select id from areas limit 1),
      '302号室'
    )
    returning id
  `;
  addressId = aRows[0]!.id;
});

afterAll(async () => {
  if (resIds.length > 0) {
    await sql`delete from reservations where id = any(${resIds}::uuid[])`;
  }
  await sql`delete from addresses where id = ${addressId}::uuid`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

// =====================================================================
// 1. getDispatchBoardCore が dispatch_driver / dispatch_memo を返す
// =====================================================================
describe("getDispatchBoardCore: dispatch_driver / dispatch_memo フィールドの存在確認", () => {
  let resId: string;
  let resDate: string;

  beforeAll(async () => {
    resId = await insertReservation(nextOffset());
    const row = await sql<{ start_at: Date }[]>`
      select start_at from reservations where id = ${resId}::uuid
    `;
    resDate = formatInTimeZone(row[0]!.start_at, TZ, "yyyy-MM-dd");
  });

  it("返却アイテムに dispatchDriver / dispatchMemo フィールドが存在する", async () => {
    const outcome = await getDispatchBoardCore(sql, receptionSession, resDate);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    const item = outcome.items.find((i) => i.reservationId === resId);
    expect(item).toBeDefined();
    if (!item) return;

    // フィールドが存在すること（初期値は null）
    expect(Object.keys(item)).toContain("dispatchDriver");
    expect(Object.keys(item)).toContain("dispatchMemo");
    expect(item.dispatchDriver).toBeNull();
    expect(item.dispatchMemo).toBeNull();
  });

  it("addressLabel フィールドが存在し、挿入時の label が返る", async () => {
    const outcome = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (outcome.kind !== "ok") return;

    const item = outcome.items.find((i) => i.reservationId === resId);
    if (!item) return;

    expect(Object.keys(item)).toContain("addressLabel");
    // 挿入時に '302号室' を label にセットした
    expect(item.addressLabel).toBe("302号室");
  });
});

// =====================================================================
// 2. updateDispatchFieldsCore: ドライバー更新
// =====================================================================
describe("updateDispatchFieldsCore: ドライバー更新", () => {
  let resId: string;
  let resDate: string;

  beforeAll(async () => {
    resId = await insertReservation(nextOffset());
    const row = await sql<{ start_at: Date }[]>`
      select start_at from reservations where id = ${resId}::uuid
    `;
    resDate = formatInTimeZone(row[0]!.start_at, TZ, "yyyy-MM-dd");
  });

  it("driver を設定でき、getDispatchBoardCore で反映される", async () => {
    const outcome = await updateDispatchFieldsCore(sql, receptionSession, {
      reservationId: resId,
      driver: "田中 ハイエース",
    });
    expect(outcome.kind).toBe("ok");

    // DB から直接確認
    const row = await sql<{ dispatch_driver: string | null }[]>`
      select dispatch_driver from reservations where id = ${resId}::uuid
    `;
    expect(row[0]!.dispatch_driver).toBe("田中 ハイエース");

    // getDispatchBoardCore で反映される
    const board = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (board.kind === "ok") {
      const item = board.items.find((i) => i.reservationId === resId);
      if (item) {
        expect(item.dispatchDriver).toBe("田中 ハイエース");
      }
    }
  });

  it("driver を空文字列に更新できる（クリア操作）", async () => {
    const outcome = await updateDispatchFieldsCore(sql, receptionSession, {
      reservationId: resId,
      driver: "",
    });
    expect(outcome.kind).toBe("ok");

    const row = await sql<{ dispatch_driver: string | null }[]>`
      select dispatch_driver from reservations where id = ${resId}::uuid
    `;
    // 空文字列として保存される
    expect(row[0]!.dispatch_driver).toBe("");
  });
});

// =====================================================================
// 3. updateDispatchFieldsCore: メモ更新
// =====================================================================
describe("updateDispatchFieldsCore: メモ更新", () => {
  let resId: string;

  beforeAll(async () => {
    resId = await insertReservation(nextOffset());
  });

  it("memo を設定できる", async () => {
    const outcome = await updateDispatchFieldsCore(sql, receptionSession, {
      reservationId: resId,
      memo: "正面玄関で待機。フロントに電話してから入る",
    });
    expect(outcome.kind).toBe("ok");

    const row = await sql<{ dispatch_memo: string | null }[]>`
      select dispatch_memo from reservations where id = ${resId}::uuid
    `;
    expect(row[0]!.dispatch_memo).toBe("正面玄関で待機。フロントに電話してから入る");
  });
});

// =====================================================================
// 4. driver と memo を同時に更新
// =====================================================================
describe("updateDispatchFieldsCore: driver + memo 同時更新", () => {
  let resId: string;

  beforeAll(async () => {
    resId = await insertReservation(nextOffset());
  });

  it("driver と memo を同時に更新できる", async () => {
    const outcome = await updateDispatchFieldsCore(sql, receptionSession, {
      reservationId: resId,
      driver: "鈴木 プリウス",
      memo: "B棟入口",
    });
    expect(outcome.kind).toBe("ok");

    const row = await sql<{ dispatch_driver: string | null; dispatch_memo: string | null }[]>`
      select dispatch_driver, dispatch_memo from reservations where id = ${resId}::uuid
    `;
    expect(row[0]!.dispatch_driver).toBe("鈴木 プリウス");
    expect(row[0]!.dispatch_memo).toBe("B棟入口");
  });
});

// =====================================================================
// 5. forbidden: therapist セッションでは更新不可
// =====================================================================
describe("updateDispatchFieldsCore: 権限チェック", () => {
  let resId: string;

  beforeAll(async () => {
    resId = await insertReservation(nextOffset());
  });

  it("therapist セッションは forbidden を返す", async () => {
    const outcome = await updateDispatchFieldsCore(sql, aoiSession, {
      reservationId: resId,
      driver: "不正更新",
    });
    expect(outcome.kind).toBe("forbidden");

    // DB に反映されていないこと
    const row = await sql<{ dispatch_driver: string | null }[]>`
      select dispatch_driver from reservations where id = ${resId}::uuid
    `;
    expect(row[0]!.dispatch_driver).toBeNull();
  });
});

// =====================================================================
// 6. not_found: 存在しない reservationId
// =====================================================================
describe("updateDispatchFieldsCore: 存在しない予約", () => {
  it("ランダム UUID は not_found を返す", async () => {
    const outcome = await updateDispatchFieldsCore(sql, receptionSession, {
      reservationId: randomUUID(),
      driver: "幽霊ドライバー",
    });
    expect(outcome.kind).toBe("not_found");
  });
});

// =====================================================================
// 7. 既存 getDispatchBoardCore の型整合: DispatchBoardItem 必須フィールド
// =====================================================================
describe("getDispatchBoardCore: 既存フィールドが壊れていない", () => {
  let resId: string;
  let resDate: string;

  beforeAll(async () => {
    resId = await insertReservation(nextOffset());
    const row = await sql<{ start_at: Date }[]>`
      select start_at from reservations where id = ${resId}::uuid
    `;
    resDate = formatInTimeZone(row[0]!.start_at, TZ, "yyyy-MM-dd");
  });

  it("既存の必須フィールドがすべて存在する", async () => {
    const outcome = await getDispatchBoardCore(sql, receptionSession, resDate);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    const item = outcome.items.find((i) => i.reservationId === resId);
    expect(item).toBeDefined();
    if (!item) return;

    // 既存フィールドの存在確認
    const requiredFields = [
      "reservationId", "status", "version",
      "therapistId", "therapistName",
      "departAtISO", "startAtISO", "endAtISO", "freeAtISO",
      "travelInMin", "travelOutMin",
      "courseName", "courseDurationMin",
      "areaName", "hotelName",
      "customerName", "customerPhone",
      "firstVisit",
      "enrouteAtISO", "arrivedAtISO", "serviceStartedAtISO", "doneAtISO",
      "delayed", "exitOverdue",
      // 新規フィールド
      "dispatchDriver", "dispatchMemo", "addressLabel",
    ] as const;

    for (const field of requiredFields) {
      expect(Object.keys(item), `フィールド "${field}" が存在すること`).toContain(field);
    }

    // 型確認
    expect(typeof item.reservationId).toBe("string");
    expect(typeof item.status).toBe("string");
    expect(typeof item.version).toBe("number");
    expect(typeof item.delayed).toBe("boolean");
    expect(typeof item.exitOverdue).toBe("boolean");
    expect(typeof item.firstVisit).toBe("boolean");
  });
});
