import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { addDaysISO, localDateISO } from "@/domain/availability";
import { getTherapistSlots } from "@/lib/availability/public-slots";
import { createHold, loadBookingFees } from "@/lib/booking/holds";
import { canGenerateDispatch } from "@/lib/booking/phone-confirmation";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import type { Role } from "@/domain/auth";

/**
 * フェーズ12 統合テスト（実 Postgres 必須 / spec 15章）。
 *
 * ★getDevSession を vi.mock して **Server Action 本体**（createPhoneOrder /
 * confirmPhoneCall / searchCustomerByPhone / createLostOrder）を実 Postgres で呼ぶ。
 * 内部 SQL の模倣ではなく実装そのものを検証する（再レビュー推奨1）。
 *
 * (a) 電話番号で既存顧客の住所・note（好み）が自動補完で引き当たる
 * (b) 不成立は理由なしで保存不可
 * (c) createPhoneOrder 枠内: 保存時 confirmed・engine 由来の depart/free と完全一致
 * (d) ★枠外(override): L にオプション duration が反映され、延長時間帯への
 *     別予約が exclusion で弾かれる（二重予約不可 / 重大A）
 * (e) 枠外の近傍枠なし（深夜等）: 暫定バッファでも end_at は L 反映・CHECK 違反なし
 * (f) 枠外は理由必須・option_availability 非対応オプションは計上しない・audit 記録
 * (g) ★confirmPhoneCall: 'confirmed' のみ phone_confirmed_at セット。
 *     'no_answer' は未確認のまま（canGenerateDispatch=false）＆再架電可（重大B）
 */

// getDevSession のモック（vi.mock はホイストされるため vi.hoisted で状態を共有）
const mockAuth = vi.hoisted(() => ({ session: null as { userId: string; role: string } | null }));
vi.mock("@/lib/cms/dev-session", () => ({
  getDevSession: async () => mockAuth.session,
}));

import {
  confirmPhoneCall,
  createLostOrder,
  createPhoneOrder,
  searchCustomerByPhone,
} from "@/app/(admin)/admin/orders/actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const TEST_PHONE_PREFIX = "0902222";
const tomorrow = addDaysISO(localDateISO(new Date()), 1);

let aoiId = "";
const aoiSlug = "aoi";
let renId = "";
let shibuyaId = "";
let shortCourseId = "";
let shortCourse = { price: 0, duration_min: 0, nomination_fee_default: 0 };
let ext30Id = "";
let ext30 = { price: 0, duration_min: 0 };

/** テストで作った行（afterEach / afterAll で掃除） */
const createdReservations: string[] = [];
const createdCustomerPhones: string[] = [];
const createdOptionIds: string[] = [];

const seedUsers = new Map<Role, { id: string }>();
function sessionOf(role: Role): Session {
  const u = seedUsers.get(role);
  if (!u) throw new Error(`seed に ${role} のテストアカウントがない`);
  return { userId: u.id, role };
}

/** オーナーセッション（全権限） */
const ownerSession = (): Session => sessionOf("owner");

beforeAll(async () => {
  const therapists = await sql<{ id: string; slug: string }[]>`
    select id, slug from therapists where slug in ('aoi', 'ren')
  `;
  aoiId = therapists.find((t) => t.slug === "aoi")?.id ?? "";
  renId = therapists.find((t) => t.slug === "ren")?.id ?? "";

  const areas = await sql<{ id: string }[]>`
    select id from areas where name = '渋谷区' limit 1
  `;
  shibuyaId = areas[0]?.id ?? "";

  const courses = await sql<
    { id: string; price: number; duration_min: number; nomination_fee_default: number }[]
  >`
    select id, price, duration_min, nomination_fee_default
    from courses where name = 'ショート' limit 1
  `;
  shortCourseId = courses[0]?.id ?? "";
  if (courses[0]) {
    shortCourse = {
      price: courses[0].price,
      duration_min: courses[0].duration_min,
      nomination_fee_default: courses[0].nomination_fee_default,
    };
  }

  const opts = await sql<{ id: string; price: number; duration_min: number }[]>`
    select id, price, duration_min from options where name = '延長30分' limit 1
  `;
  ext30Id = opts[0]?.id ?? "";
  if (opts[0]) ext30 = { price: opts[0].price, duration_min: opts[0].duration_min };

  const users = await sql<{ id: string; role: Role }[]>`
    select id, role from app_users where display_name like '（ダミー）%'
  `;
  for (const r of users) seedUsers.set(r.role, { id: r.id });

  expect(aoiId).not.toBe("");
  expect(renId).not.toBe("");
  expect(shibuyaId).not.toBe("");
  expect(shortCourseId).not.toBe("");
  expect(ext30Id).not.toBe("");
  expect(ext30.duration_min).toBeGreaterThan(0);
  expect(seedUsers.has("owner")).toBe(true);

  // 実 Server Action を owner として呼ぶ（getDevSession モック）
  mockAuth.session = ownerSession();
});

afterEach(async () => {
  mockAuth.session = ownerSession();
  if (createdReservations.length > 0) {
    await sql`
      delete from reservations
      where id = any(${createdReservations}::uuid[])
    `;
    createdReservations.length = 0;
  }
  if (createdCustomerPhones.length > 0) {
    // reservations → addresses(cascade) の順が守られるよう顧客は後で消す
    await sql`
      delete from customers where phone = any(${createdCustomerPhones})
    `;
    createdCustomerPhones.length = 0;
  }
  if (createdOptionIds.length > 0) {
    await sql`
      delete from options where id = any(${createdOptionIds}::uuid[])
    `;
    createdOptionIds.length = 0;
  }
  // audit_logs, call_logs, lost_orders の掃除は行わない（追記専用）
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 翌日の aoi の候補枠（渋谷・ショート + 指定オプション）。engine の生スロット込み */
async function aoiSlots(optionIds: string[] = []) {
  const res = await getTherapistSlots({
    slug: aoiSlug,
    dateISO: tomorrow,
    courseId: shortCourseId,
    areaId: shibuyaId,
    optionIds,
  });
  expect(res).not.toBeNull();
  expect(res!.slots.length).toBeGreaterThan(0);
  return res!;
}

function orderForm(overrides: Partial<Parameters<typeof createPhoneOrder>[0]> & { phone: string; startAtISO: string }) {
  return {
    customerName: "テスト太郎",
    destinationType: "home" as const,
    addressDetail: "東京都渋谷区テスト1-2-3",
    areaId: shibuyaId,
    therapistId: aoiId,
    therapistSlug: aoiSlug,
    courseId: shortCourseId,
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// テスト (a): 既存顧客の自動補完（実アクション searchCustomerByPhone）
// -------------------------------------------------------------------------
describe("(a) 電話番号で既存顧客の住所・note が自動補完で引き当たる", () => {
  it("searchCustomerByPhone（実アクション）で note と addressDetail が返る", async () => {
    const phone = `${TEST_PHONE_PREFIX}001`;
    createdCustomerPhones.push(phone);

    await withUser(sql, ownerSession(), async (tx) => {
      const customers = await tx<{ id: string }[]>`
        insert into customers (phone, name, note)
        values (${phone}, 'テスト太郎', '強めのマッサージ希望')
        returning id
      `;
      await tx`
        insert into addresses (customer_id, kind, detail, area_id)
        values (
          ${customers[0]!.id}::uuid,
          'home'::address_kind,
          '東京都渋谷区テスト1-2-3',
          ${shibuyaId}::uuid
        )
      `;
    });

    const res = await searchCustomerByPhone(phone);
    expect(res.ok).toBe(true);
    expect(res.data).not.toBeNull();
    expect(res.data!.name).toBe("テスト太郎");
    expect(res.data!.note).toBe("強めのマッサージ希望");
    expect(res.data!.addressDetail).toBe("東京都渋谷区テスト1-2-3");
    expect(res.data!.areaId).toBe(shibuyaId);
  });

  it("未認証（session なし）はエラー", async () => {
    mockAuth.session = null;
    const res = await searchCustomerByPhone(`${TEST_PHONE_PREFIX}001`);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("認証が必要です");
  });
});

// -------------------------------------------------------------------------
// テスト (b): 不成立理由必須（実アクション createLostOrder）
// -------------------------------------------------------------------------
describe("(b) 不成立は理由なしで保存不可", () => {
  it("不正な reason は Zod で拒否・有効な reason は lost_orders に insert される", async () => {
    const phone = `${TEST_PHONE_PREFIX}002`;

    const invalid = await createLostOrder({
      phone,
      reason: "invalid" as unknown as "time",
    });
    expect(invalid.ok).toBe(false);

    const before = await sql<{ count: string }[]>`
      select count(*)::text as count from lost_orders where phone = ${phone}
    `;
    const beforeCount = Number(before[0]!.count);

    const valid = await createLostOrder({ phone, reason: "time", note: "テスト理由" });
    expect(valid.ok).toBe(true);
    expect(valid.data?.id).toBeTruthy();

    const after = await sql<{ count: string; created_by: string | null }[]>`
      select count(*)::text as count, max(created_by::text) as created_by
      from lost_orders where phone = ${phone}
    `;
    expect(Number(after[0]!.count)).toBe(beforeCount + 1);
    expect(after[0]!.created_by).toBe(ownerSession().userId);
  });
});

// -------------------------------------------------------------------------
// テスト (c): createPhoneOrder 枠内（実アクション ★）
// -------------------------------------------------------------------------
describe("(c) createPhoneOrder 枠内: confirmed・engine 由来の depart/free と完全一致", () => {
  it("★実アクションで保存され、占有区間が engine の rawSlot と厳密に一致する", async () => {
    const phone = `${TEST_PHONE_PREFIX}003`;
    createdCustomerPhones.push(phone);

    const engine = await aoiSlots([ext30Id]);
    const slot = engine.rawSlots[0]!;
    const startAtISO = slot.startAt.toISOString();

    const res = await createPhoneOrder(
      orderForm({ phone, startAtISO, optionIds: [ext30Id], preferences: "アロマ強め" }),
    );
    expect(res.ok).toBe(true);
    expect(res.data?.reservationId).toBeTruthy();
    createdReservations.push(res.data!.reservationId);

    const rows = await sql<{
      status: string;
      source: string;
      phone_confirmed_at: Date | null;
      phone_confirmed_by: string | null;
      start_at: Date;
      end_at: Date;
      depart_at: Date;
      free_at: Date;
      travel_in_min: number;
      travel_out_min: number;
      buffer_min: number;
      nomination_fee: number;
      transport_fee: number;
      total_amount: number;
    }[]>`
      select status, source::text, phone_confirmed_at, phone_confirmed_by::text,
             start_at, end_at, depart_at, free_at,
             travel_in_min, travel_out_min, buffer_min,
             nomination_fee, transport_fee, total_amount
      from reservations where id = ${res.data!.reservationId}::uuid
    `;
    const row = rows[0]!;
    expect(row.status).toBe("confirmed");
    expect(row.source).toBe("phone");
    // 電話注文は保存時に確認済み（本人と通話中 / spec 6章）
    expect(row.phone_confirmed_at).not.toBeNull();
    expect(row.phone_confirmed_by).toBe(ownerSession().userId);

    // ★engine の rawSlot と厳密一致（弱アサーション diffMin!==25 を実値検証に強化）
    expect(row.start_at.getTime()).toBe(slot.startAt.getTime());
    expect(row.end_at.getTime()).toBe(slot.serviceEndAt.getTime());
    expect(row.depart_at.getTime()).toBe(slot.departAt.getTime());
    expect(row.free_at.getTime()).toBe(slot.freeAt.getTime());
    expect(row.travel_in_min).toBe(slot.travelInMin);
    expect(row.travel_out_min).toBe(slot.travelOutMin);
    expect(row.buffer_min).toBe(slot.bufferTotalMin);

    // end_at にオプション duration が入っている（L = before + コース + 延長30）
    const endDiffMin = (row.end_at.getTime() - row.start_at.getTime()) / 60_000;
    expect(endDiffMin).toBe(
      slot.buffers.beforeMin + shortCourse.duration_min + ext30.duration_min,
    );

    // reservation_options スナップショット
    const snap = await sql<{ option_id: string; duration_snapshot: number }[]>`
      select option_id::text, duration_snapshot from reservation_options
      where reservation_id = ${res.data!.reservationId}::uuid
    `;
    expect(snap.length).toBe(1);
    expect(snap[0]!.option_id).toBe(ext30Id);
    expect(snap[0]!.duration_snapshot).toBe(ext30.duration_min);

    // 金額はサーバ計算（コース + オプション + 指名料 + 交通費。昼帯なので深夜加算 0）
    expect(row.nomination_fee).toBe(shortCourse.nomination_fee_default);
    expect(row.total_amount).toBe(
      shortCourse.price + ext30.price + row.nomination_fee + row.transport_fee,
    );

    // 顧客 note（好み）が保存される
    const customers = await sql<{ note: string | null }[]>`
      select note from customers where phone = ${phone}
    `;
    expect(customers[0]!.note).toBe("アロマ強め");
  });
});

// -------------------------------------------------------------------------
// テスト (d): 枠外 override + 延長オプション（★重大A: 占有に L 反映・二重予約不可）
// -------------------------------------------------------------------------
describe("(d) 枠外(override): 占有区間に L が反映され延長時間帯への別予約が弾かれる", () => {
  it("★end_at/free_at にオプション duration が乗り、depart/free は近傍枠の相対オフセット", async () => {
    const phone = `${TEST_PHONE_PREFIX}004`;
    createdCustomerPhones.push(phone);

    const engine = await aoiSlots([ext30Id]);
    // 15分グリッド外（先頭枠 + 5分）= createHold は slot_gone → override 経路
    const overrideStartMs = Date.parse(engine.slots[0]!.startAtISO) + 5 * 60_000;
    const overrideStartISO = new Date(overrideStartMs).toISOString();

    // 期待値: アクションと同じ判定で近傍枠を特定し、相対オフセットで写す
    const nearby = engine.rawSlots.find(
      (s) => Math.abs(s.startAt.getTime() - overrideStartMs) < 60 * 60_000,
    );
    expect(nearby).toBeTruthy();
    const L = shortCourse.duration_min + ext30.duration_min;
    const expectedEndMs = overrideStartMs + (nearby!.buffers.beforeMin + L) * 60_000;
    const departOffsetMs = nearby!.startAt.getTime() - nearby!.departAt.getTime();
    const freeOffsetMs = nearby!.freeAt.getTime() - nearby!.serviceEndAt.getTime();
    const expectedDepartMs = overrideStartMs - departOffsetMs;
    const expectedFreeMs = expectedEndMs + freeOffsetMs;

    const res = await createPhoneOrder(
      orderForm({
        phone,
        startAtISO: overrideStartISO,
        optionIds: [ext30Id],
        overrideReason: "顧客希望の特別対応",
      }),
    );
    expect(res.ok).toBe(true);
    createdReservations.push(res.data!.reservationId);

    const rows = await sql<{
      status: string;
      start_at: Date;
      end_at: Date;
      depart_at: Date;
      free_at: Date;
      travel_in_min: number;
      travel_out_min: number;
      buffer_min: number;
    }[]>`
      select status, start_at, end_at, depart_at, free_at,
             travel_in_min, travel_out_min, buffer_min
      from reservations where id = ${res.data!.reservationId}::uuid
    `;
    const row = rows[0]!;
    expect(row.status).toBe("confirmed");
    // ★重大A-1: end_at = s + before + L（延長オプション込み）・free_at = end_at + after
    expect(row.end_at.getTime()).toBe(expectedEndMs);
    expect(row.free_at.getTime()).toBe(expectedFreeMs);
    // ★重大A-2: depart/free は絶対時刻コピーでなく相対オフセット
    expect(row.depart_at.getTime()).toBe(expectedDepartMs);
    expect(row.depart_at.getTime()).not.toBe(nearby!.departAt.getTime());
    expect(row.free_at.getTime()).not.toBe(nearby!.freeAt.getTime());
    // CHECK（reservations_occupy_order_check）を満たす
    expect(row.depart_at.getTime()).toBeLessThanOrEqual(row.start_at.getTime());
    expect(row.free_at.getTime()).toBeGreaterThanOrEqual(row.end_at.getTime());
    // travel/mode は近傍枠から
    expect(row.travel_in_min).toBe(nearby!.travelInMin);
    expect(row.travel_out_min).toBe(nearby!.travelOutMin);
    expect(row.buffer_min).toBe(nearby!.bufferTotalMin);

    // ★二重予約不可: 延長時間帯（オプション分の末尾）に重なる別予約は exclusion が拒否。
    // バグ（L 未反映）なら free_at が 30分早く、この insert は成功してしまう
    const clashDepart = new Date(expectedEndMs - 5 * 60_000);
    const clashFree = new Date(expectedEndMs + 55 * 60_000);
    const clashStart = new Date(clashDepart.getTime() + 10 * 60_000);
    const clashEnd = new Date(clashFree.getTime() - 10 * 60_000);
    let caught: unknown = null;
    try {
      await sql`
        insert into reservations (
          therapist_id, area_id, course_id, start_at, end_at, depart_at, free_at,
          travel_in_min, travel_out_min, buffer_min, status,
          nomination_fee, transport_fee, total_amount
        ) values (
          ${aoiId}::uuid, ${shibuyaId}::uuid, ${shortCourseId}::uuid,
          ${clashStart}, ${clashEnd}, ${clashDepart}, ${clashFree},
          10, 10, 25, 'held'::reservation_status, 0, 0, 0
        )
        returning id
      `;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(postgres.PostgresError);
    const err = caught as postgres.PostgresError;
    expect(err.code).toBe("23P01");
    expect(err.constraint_name).toBe("no_therapist_overlap");

    // engine 再計算でも重なった元の枠は消えている（createHold は取れない）
    const retry = await createHold({
      slug: aoiSlug,
      dateISO: tomorrow,
      startAtISO: engine.slots[0]!.startAtISO,
      areaId: shibuyaId,
      courseId: shortCourseId,
      sessionId: `test-${randomUUID()}`,
    });
    expect(retry.ok).toBe(false);

    // audit_logs に override が記録されている
    const audit = await sql<{ action: string; reason: string | null }[]>`
      select action, after->>'reason' as reason
      from audit_logs
      where entity_id = ${res.data!.reservationId}::uuid and action = 'override'
    `;
    expect(audit.length).toBe(1);
    expect(audit[0]!.reason).toBe("顧客希望の特別対応");
  });
});

// -------------------------------------------------------------------------
// テスト (e): 枠外の近傍枠なし（深夜等）= 暫定バッファでも L 反映・CHECK 違反なし
// -------------------------------------------------------------------------
describe("(e) 枠外(override) 近傍枠なし: 暫定バッファでも end_at は L 反映", () => {
  it("深夜 23:30 開始（シフト外）でも end_at = s + before + L・free_at = end_at + after", async () => {
    const phone = `${TEST_PHONE_PREFIX}005`;
    createdCustomerPhones.push(phone);

    // JST 23:30 = UTC 14:30（シフト 10:00-19:00 の全 rawSlot から 60分超離れている）
    const overrideStartISO = `${tomorrow}T14:30:00.000Z`;
    const overrideStartMs = Date.parse(overrideStartISO);

    const res = await createPhoneOrder(
      orderForm({
        phone,
        startAtISO: overrideStartISO,
        optionIds: [ext30Id],
        overrideReason: "深夜の特別対応",
      }),
    );
    expect(res.ok).toBe(true);
    createdReservations.push(res.data!.reservationId);

    // 期待値: travel_buffers 既定行（未投入なら arrive10/parking15/before5/after10）
    const bufferRows = await sql<{
      arrive_min: number;
      parking_min: number;
      before_min: number;
      after_min: number;
    }[]>`
      select arrive_min, parking_min, before_min, after_min
      from travel_buffers where scope = 'default' limit 1
    `;
    const buf = bufferRows[0] ?? {
      arrive_min: 10,
      parking_min: 15,
      before_min: 5,
      after_min: 10,
    };
    const L = shortCourse.duration_min + ext30.duration_min;
    const expectedEndMs = overrideStartMs + (buf.before_min + L) * 60_000;
    // 暫定は car 明示: 到着バッファ = arrive + parking（自宅なのでホテル加算なし）+ 移動30分
    const expectedDepartMs =
      overrideStartMs - (buf.arrive_min + buf.parking_min + 30) * 60_000;
    const expectedFreeMs = expectedEndMs + buf.after_min * 60_000;

    const rows = await sql<{
      start_at: Date;
      end_at: Date;
      depart_at: Date;
      free_at: Date;
      travel_in_min: number;
      travel_out_min: number;
      buffer_min: number;
      transport_fee: number;
      total_amount: number;
    }[]>`
      select start_at, end_at, depart_at, free_at,
             travel_in_min, travel_out_min, buffer_min, transport_fee, total_amount
      from reservations where id = ${res.data!.reservationId}::uuid
    `;
    const row = rows[0]!;
    expect(row.end_at.getTime()).toBe(expectedEndMs);
    expect(row.free_at.getTime()).toBe(expectedFreeMs);
    expect(row.depart_at.getTime()).toBe(expectedDepartMs);
    // 暫定は walk 固定にせず car 明示（移動30分・駐車バッファ込み / 推奨4）
    expect(row.travel_in_min).toBe(30);
    expect(row.travel_out_min).toBe(30);
    expect(row.buffer_min).toBe(
      buf.arrive_min + buf.parking_min + buf.before_min + buf.after_min,
    );
    const fees = await loadBookingFees();
    expect(row.transport_fee).toBe(fees.transportCar);
    // JST 23:30 開始は深夜帯 [0,5) に入らない → 深夜加算なし
    expect(row.total_amount).toBe(
      shortCourse.price + ext30.price + shortCourse.nomination_fee_default + fees.transportCar,
    );
  });
});

// -------------------------------------------------------------------------
// テスト (f): 枠外の理由必須・option_availability の尊重
// -------------------------------------------------------------------------
describe("(f) 枠外は理由必須・非対応オプションは計上しない", () => {
  it("overrideReason なしの枠外は「枠外予約には理由が必要です」", async () => {
    const phone = `${TEST_PHONE_PREFIX}006`;
    createdCustomerPhones.push(phone);
    const engine = await aoiSlots();
    const offGridISO = new Date(
      Date.parse(engine.slots[0]!.startAtISO) + 5 * 60_000,
    ).toISOString();

    const res = await createPhoneOrder(orderForm({ phone, startAtISO: offGridISO }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("枠外予約には理由が必要です");

    // 予約は作られていない
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from reservations
      where therapist_id = ${aoiId}::uuid and start_at = ${new Date(offGridISO)}
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("option_availability で aoi 非対応のオプションは L にも snapshot にも入らない（重大A-4）", async () => {
    const phone = `${TEST_PHONE_PREFIX}007`;
    createdCustomerPhones.push(phone);

    // ren だけが対応するオプション（duration 45分）を作る
    const restricted = await sql<{ id: string }[]>`
      insert into options (name, price, duration_min, back_type, back_value, is_public, is_active)
      values (${`テスト限定45分-${randomUUID().slice(0, 8)}`}, 4500, 45, 'fixed', 0, true, true)
      returning id
    `;
    const restrictedId = restricted[0]!.id;
    createdOptionIds.push(restrictedId);
    await sql`
      insert into option_availability (option_id, therapist_id)
      values (${restrictedId}::uuid, ${renId}::uuid)
    `;

    const engine = await aoiSlots([ext30Id]);
    const overrideStartMs = Date.parse(engine.slots[0]!.startAtISO) + 5 * 60_000;
    const nearby = engine.rawSlots.find(
      (s) => Math.abs(s.startAt.getTime() - overrideStartMs) < 60 * 60_000,
    )!;

    const res = await createPhoneOrder(
      orderForm({
        phone,
        startAtISO: new Date(overrideStartMs).toISOString(),
        optionIds: [restrictedId, ext30Id],
        overrideReason: "非対応オプション混在テスト",
      }),
    );
    expect(res.ok).toBe(true);
    createdReservations.push(res.data!.reservationId);

    // L は ext30 のみ（+30分）。非対応の 45分 は計上されない
    const rows = await sql<{ start_at: Date; end_at: Date }[]>`
      select start_at, end_at from reservations
      where id = ${res.data!.reservationId}::uuid
    `;
    const endDiffMin =
      (rows[0]!.end_at.getTime() - rows[0]!.start_at.getTime()) / 60_000;
    expect(endDiffMin).toBe(
      nearby.buffers.beforeMin + shortCourse.duration_min + ext30.duration_min,
    );

    // snapshot も ext30 のみ
    const snap = await sql<{ option_id: string }[]>`
      select option_id::text from reservation_options
      where reservation_id = ${res.data!.reservationId}::uuid
    `;
    expect(snap.map((s) => s.option_id)).toEqual([ext30Id]);
  });
});

// -------------------------------------------------------------------------
// テスト (g): confirmPhoneCall のゲート（★重大B: 不通は確認済みにしない）
// -------------------------------------------------------------------------
describe("(g) confirmPhoneCall: 'confirmed' のみ確認済み・'no_answer' は再架電可", () => {
  /** Web 予約（confirmed / phone_confirmed_at=null）を直接用意する */
  async function makeWebReservation(phone: string): Promise<string> {
    createdCustomerPhones.push(phone);
    const startAt = new Date(`${tomorrow}T03:00:00.000Z`); // JST 12:00
    const endAt = new Date(startAt.getTime() + 60 * 60_000);
    const departAt = new Date(startAt.getTime() - 25 * 60_000);
    const freeAt = new Date(endAt.getTime() + 10 * 60_000);

    const customers = await sql<{ id: string }[]>`
      insert into customers (phone, name) values (${phone}, 'テスト次郎')
      returning id
    `;
    const addresses = await sql<{ id: string }[]>`
      insert into addresses (customer_id, kind, detail, area_id)
      values (${customers[0]!.id}::uuid, 'home'::address_kind, 'テスト住所', ${shibuyaId}::uuid)
      returning id
    `;
    const rows = await sql<{ id: string }[]>`
      insert into reservations (
        therapist_id, customer_id, address_id, area_id, course_id,
        start_at, end_at, depart_at, free_at,
        travel_in_min, travel_out_min, buffer_min,
        status, nomination_fee, transport_fee, total_amount, source
      ) values (
        ${renId}::uuid, ${customers[0]!.id}::uuid, ${addresses[0]!.id}::uuid,
        ${shibuyaId}::uuid, ${shortCourseId}::uuid,
        ${startAt}, ${endAt}, ${departAt}, ${freeAt},
        15, 15, 30,
        'confirmed'::reservation_status, 0, 0, 5000,
        'web'::reservation_source
      )
      returning id
    `;
    createdReservations.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function fetchGate(reservationId: string) {
    const rows = await sql<{
      status: string;
      phone_confirmed_at: Date | null;
      phone_confirmed_by: string | null;
      version: number;
    }[]>`
      select status, phone_confirmed_at, phone_confirmed_by::text, version
      from reservations where id = ${reservationId}::uuid
    `;
    return rows[0]!;
  }

  it("★'no_answer' は未確認のまま（canGenerateDispatch=false）で再架電できる", async () => {
    const reservationId = await makeWebReservation(`${TEST_PHONE_PREFIX}008`);
    const before = await fetchGate(reservationId);

    // 1回目の架電: 不通
    const first = await confirmPhoneCall(reservationId, "no_answer", "1回目不通");
    expect(first.ok).toBe(true);

    const afterFirst = await fetchGate(reservationId);
    // ★重大B: 不通は確認済みにしない
    expect(afterFirst.phone_confirmed_at).toBeNull();
    expect(afterFirst.phone_confirmed_by).toBeNull();
    expect(afterFirst.version).toBe(before.version); // version も不変
    expect(
      canGenerateDispatch({
        status: afterFirst.status,
        phone_confirmed_at: afterFirst.phone_confirmed_at,
      }),
    ).toBe(false);

    // 2回目の架電: 「既に確認済み」で拒否されず再架電できる（3回不通運用の前提）
    const second = await confirmPhoneCall(reservationId, "no_answer", "2回目不通");
    expect(second.ok).toBe(true);

    // call_logs に2件の no_answer が積まれている
    const logs = await sql<{ result: string }[]>`
      select result::text from call_logs
      where reservation_id = ${reservationId}::uuid
      order by called_at asc
    `;
    expect(logs.map((l) => l.result)).toEqual(["no_answer", "no_answer"]);

    // 3回目: 本人につながった → confirmed でゲートが開く
    const third = await confirmPhoneCall(reservationId, "confirmed", "本人確認済み");
    expect(third.ok).toBe(true);
    const afterThird = await fetchGate(reservationId);
    expect(afterThird.phone_confirmed_at).not.toBeNull();
    expect(afterThird.phone_confirmed_by).toBe(ownerSession().userId);
    expect(afterThird.version).toBe(before.version + 1);
    expect(
      canGenerateDispatch({
        status: afterThird.status,
        phone_confirmed_at: afterThird.phone_confirmed_at,
      }),
    ).toBe(true);
  });

  it("'confirmed' は phone_confirmed_at をセットし、二重確認は拒否される", async () => {
    const reservationId = await makeWebReservation(`${TEST_PHONE_PREFIX}009`);

    const res = await confirmPhoneCall(reservationId, "confirmed", "確認済み");
    expect(res.ok).toBe(true);
    const after = await fetchGate(reservationId);
    expect(after.phone_confirmed_at).not.toBeNull();
    expect(
      canGenerateDispatch({
        status: after.status,
        phone_confirmed_at: after.phone_confirmed_at,
      }),
    ).toBe(true);

    // 既に確認済みの再実行はエラー
    const again = await confirmPhoneCall(reservationId, "confirmed");
    expect(again.ok).toBe(false);
    expect(again.error).toContain("既に電話確認済み");

    // 'other'（本人不在等）も確認状態は変えず、ログだけ積める
    const other = await confirmPhoneCall(reservationId, "other", "家族が応答");
    expect(other.ok).toBe(true);
    const logs = await sql<{ result: string }[]>`
      select result::text from call_logs
      where reservation_id = ${reservationId}::uuid
      order by called_at asc
    `;
    expect(logs.map((l) => l.result)).toEqual(["confirmed", "other"]);
  });

  it("存在しない予約は 'no_answer' でもエラー", async () => {
    const res = await confirmPhoneCall(randomUUID(), "no_answer");
    expect(res.ok).toBe(false);
  });
});
