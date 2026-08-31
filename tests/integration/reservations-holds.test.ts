import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import type { Role } from "@/domain/auth";
import { addDaysISO, localDateISO } from "@/domain/availability";
import { getTherapistSlots } from "@/lib/availability/public-slots";
import {
  confirmReservation,
  createHold,
  releaseExpiredHolds,
  releaseHold,
} from "@/lib/booking/holds";
import { recordFunnelEvent } from "@/lib/booking/funnel";

/**
 * フェーズ11 の統合テスト（実 Postgres 必須 / spec 15章 ★最優先）。
 *
 * - **仮押さえ: 同時2リクエストで片方だけが成功する**（exclusion 制約の裁定。
 *   モックでは検証できない / spec 5-5・15章）
 * - **楽観ロック: 古い version での保存が拒否される**（spec 4章・15章）
 * - exclusion: 隣接（free_at = 次の depart_at）は '[)' で重複でない / 重なりは弾く /
 *   cancelled は占有しない
 * - 期限切れホールドの解放（release_expired_holds + 参照時の除外）
 * - 確定で held → confirmed・reservation_options スナップショット・電話番号名寄せ
 * - ファネル計測（hold / confirm がトランザクション内で記録される）
 * - RLS: therapist は他人の予約・顧客住所を取得できない（spec 15章「権限」）
 *
 * 前提: pnpm db:reset 済み。シードの aoi（公開・徒歩・国分町事務所・翌日 10:00-19:00
 * シフト・上限3本）を使う。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const TEST_PHONE_PREFIX = "0901111";
let renId = "";
let aoiId = "";
let shibuyaId = "";
let shortCourseId = "";
let ext30Id = "";
const tomorrow = addDaysISO(localDateISO(new Date()), 1);

/** テストで作った予約 id（afterEach で掃除） */
const createdReservations: string[] = [];
const createdSessions: string[] = [];

const seedUsers = new Map<Role, { id: string }>();
function sessionOf(role: Role): Session {
  const u = seedUsers.get(role);
  if (!u) throw new Error(`seed に ${role} のテストアカウントがない`);
  return { userId: u.id, role };
}

beforeAll(async () => {
  const therapists = await sql<{ id: string; slug: string }[]>`
    select id, slug from therapists where slug in ('aoi', 'ren')
  `;
  aoiId = therapists.find((t) => t.slug === "aoi")?.id ?? "";
  renId = therapists.find((t) => t.slug === "ren")?.id ?? "";
  const areas = await sql<{ id: string }[]>`
    select id from areas where name = '国分町' limit 1
  `;
  shibuyaId = areas[0]?.id ?? "";
  const courses = await sql<{ id: string; name: string }[]>`
    select id, name from courses where name in ('ショート')
  `;
  shortCourseId = courses[0]?.id ?? "";
  const opts = await sql<{ id: string }[]>`
    select id from options where name = '延長30分' limit 1
  `;
  ext30Id = opts[0]?.id ?? "";
  const users = await sql<{ id: string; role: Role }[]>`
    select id, role from app_users where display_name like '（ダミー）%'
  `;
  for (const r of users) seedUsers.set(r.role, { id: r.id });
  expect(aoiId).not.toBe("");
  expect(renId).not.toBe("");
  expect(shibuyaId).not.toBe("");
  expect(shortCourseId).not.toBe("");
  expect(ext30Id).not.toBe("");
});

afterEach(async () => {
  // 予約 → 顧客（addresses は cascade）→ ファネルの順で掃除
  await sql`
    delete from reservations
    where id = any(${createdReservations}::uuid[])
       or therapist_id in (${aoiId}::uuid, ${renId}::uuid)
  `;
  await sql`delete from customers where phone like ${TEST_PHONE_PREFIX + "%"}`;
  if (createdSessions.length > 0) {
    await sql`delete from funnel_events where session_id = any(${createdSessions})`;
  }
  createdReservations.length = 0;
  createdSessions.length = 0;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

function newSession(): string {
  const id = `test-${randomUUID()}`;
  createdSessions.push(id);
  return id;
}

/** 素の insert（engine を通さず exclusion 制約そのものを検証する） */
async function insertReservation(
  client: postgres.Sql,
  params: {
    therapistId: string;
    departISO: string;
    freeISO: string;
    status?: string;
  },
): Promise<string> {
  const depart = new Date(params.departISO);
  const free = new Date(params.freeISO);
  // start/end は占有区間の内側に置く（check 制約: depart ≤ start < end ≤ free）
  const start = new Date(depart.getTime() + 10 * 60_000);
  const end = new Date(free.getTime() - 10 * 60_000);
  const rows = await client<{ id: string }[]>`
    insert into reservations (
      therapist_id, area_id, course_id, start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min, status,
      nomination_fee, transport_fee, total_amount
    ) values (
      ${params.therapistId}::uuid, ${shibuyaId}::uuid, ${shortCourseId}::uuid,
      ${start}, ${end}, ${depart}, ${free},
      10, 10, 25, ${params.status ?? "held"}::reservation_status,
      0, 0, 0
    )
    returning id
  `;
  const id = rows[0]!.id;
  createdReservations.push(id);
  return id;
}

describe("exclusion 制約 no_therapist_overlap（spec 4章 ★最重要）", () => {
  const base = `${tomorrow}T03:00:00.000Z`; // JST 12:00
  const baseEnd = `${tomorrow}T05:00:00.000Z`; // JST 14:00

  it("★同時2リクエスト: 同一セラピスト・重なる占有区間の並行 insert は片方だけ成功する", async () => {
    // 別々の接続から本当に並行で流す（トランザクション直列化ではなく制約の裁定）
    const clientA = postgres(url, { max: 1, onnotice: () => {} });
    const clientB = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const results = await Promise.allSettled([
        insertReservation(clientA, { therapistId: renId, departISO: base, freeISO: baseEnd }),
        insertReservation(clientB, {
          therapistId: renId,
          departISO: `${tomorrow}T04:00:00.000Z`,
          freeISO: `${tomorrow}T06:00:00.000Z`,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      const err = rejected[0]!.reason as postgres.PostgresError;
      // 通常は exclusion 違反（23P01）。完全同時に投機エントリを待ち合った場合、
      // Postgres は deadlock（40P01）として片方を中断する（裁定はどちらも正しい）
      expect(["23P01", "40P01"]).toContain(err.code);
      if (err.code === "23P01") {
        expect(err.constraint_name).toBe("no_therapist_overlap");
      }
    } finally {
      await clientA.end({ timeout: 5 });
      await clientB.end({ timeout: 5 });
    }
  });

  it("確定済みの占有区間に重なる insert は 23P01（no_therapist_overlap）で拒否される", async () => {
    await insertReservation(sql, { therapistId: renId, departISO: base, freeISO: baseEnd });
    let caught: unknown = null;
    try {
      await insertReservation(sql, {
        therapistId: renId,
        departISO: `${tomorrow}T04:00:00.000Z`,
        freeISO: `${tomorrow}T06:00:00.000Z`,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(postgres.PostgresError);
    const err = caught as postgres.PostgresError;
    expect(err.code).toBe("23P01");
    expect(err.constraint_name).toBe("no_therapist_overlap");
  });

  it("隣接（free_at = 次の depart_at）は '[)' 半開なので両方成功する", async () => {
    await insertReservation(sql, { therapistId: renId, departISO: base, freeISO: baseEnd });
    await expect(
      insertReservation(sql, {
        therapistId: renId,
        departISO: baseEnd,
        freeISO: `${tomorrow}T07:00:00.000Z`,
      }),
    ).resolves.toBeTruthy();
  });

  it("別セラピストなら同時間帯でも重複にならない", async () => {
    await insertReservation(sql, { therapistId: renId, departISO: base, freeISO: baseEnd });
    await expect(
      insertReservation(sql, { therapistId: aoiId, departISO: base, freeISO: baseEnd }),
    ).resolves.toBeTruthy();
  });

  it("cancelled / noshow は占有しない（where 句の status 限定）", async () => {
    await insertReservation(sql, {
      therapistId: renId,
      departISO: base,
      freeISO: baseEnd,
      status: "cancelled",
    });
    await expect(
      insertReservation(sql, { therapistId: renId, departISO: base, freeISO: baseEnd }),
    ).resolves.toBeTruthy();
  });
});

describe("仮押さえ createHold（spec 5-5 / 完了条件）", () => {
  async function firstSlotStartISO(): Promise<string> {
    const res = await getTherapistSlots({
      slug: "aoi",
      dateISO: tomorrow,
      courseId: shortCourseId,
    });
    expect(res).not.toBeNull();
    expect(res!.slots.length).toBeGreaterThan(0);
    return res!.slots[0]!.startAtISO;
  }

  it("★同じ枠への同時2リクエストは片方だけ成功し、敗者は列挙コードで弾かれる", async () => {
    const startAtISO = await firstSlotStartISO();
    const [a, b] = await Promise.all([
      createHold({
        slug: "aoi",
        dateISO: tomorrow,
        startAtISO,
        courseId: shortCourseId,
        sessionId: newSession(),
      }),
      createHold({
        slug: "aoi",
        dateISO: tomorrow,
        startAtISO,
        courseId: shortCourseId,
        sessionId: newSession(),
      }),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    const winner = winners[0]!;
    if (winner.ok) createdReservations.push(winner.reservationId);
    const loser = losers[0]!;
    // 敗者は exclusion の裁定（slot_taken）か、再計算時点で消えた枠（slot_gone）。
    // どちらも「生の Postgres エラーを出さず」列挙コードで返る（spec 4章）
    if (!loser.ok) {
      expect(["slot_taken", "slot_gone"]).toContain(loser.error);
    }
    // DB 上も held は1件だけ
    const held = await sql<{ n: string }[]>`
      select count(*)::text as n from reservations
      where therapist_id = ${aoiId}::uuid and status = 'held'
    `;
    expect(Number(held[0]?.n)).toBe(1);
  });

  it("ホールドした枠は次の再計算から消え、解放すると戻る", async () => {
    const startAtISO = await firstSlotStartISO();
    const sessionId = newSession();
    const hold = await createHold({
      slug: "aoi",
      dateISO: tomorrow,
      startAtISO,
      courseId: shortCourseId,
      sessionId,
    });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    createdReservations.push(hold.reservationId);

    const after = await getTherapistSlots({
      slug: "aoi",
      dateISO: tomorrow,
      courseId: shortCourseId,
    });
    expect(after!.slots.map((s) => s.startAtISO)).not.toContain(startAtISO);

    // 明示解放（session 一致）で枠が戻る
    const released = await releaseHold({ reservationId: hold.reservationId, sessionId });
    expect(released).toBe(true);
    const restored = await getTherapistSlots({
      slug: "aoi",
      dateISO: tomorrow,
      courseId: shortCourseId,
    });
    expect(restored!.slots.map((s) => s.startAtISO)).toContain(startAtISO);
  });

  it("期限切れホールドは参照時に除外され、release_expired_holds が行ごと解放する", async () => {
    const startAtISO = await firstSlotStartISO();
    const hold = await createHold({
      slug: "aoi",
      dateISO: tomorrow,
      startAtISO,
      courseId: shortCourseId,
      sessionId: newSession(),
    });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    createdReservations.push(hold.reservationId);

    // 期限を過去に倒す（10分待たない）
    await sql`
      update slot_holds set expires_at = now() - interval '1 second'
      where reservation_id = ${hold.reservationId}::uuid
    `;

    // 参照時の除外: 解放前でも枠として案内される
    const view = await getTherapistSlots({
      slug: "aoi",
      dateISO: tomorrow,
      courseId: shortCourseId,
    });
    expect(view!.slots.map((s) => s.startAtISO)).toContain(startAtISO);

    // クリーンアップ関数が held 行ごと削除する
    const released = await releaseExpiredHolds();
    expect(released).toBeGreaterThanOrEqual(1);
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from reservations
      where id = ${hold.reservationId}::uuid
    `;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("存在しない枠（細工した時刻）は slot_gone", async () => {
    const res = await createHold({
      slug: "aoi",
      dateISO: tomorrow,
      startAtISO: `${tomorrow}T03:07:00.000Z`, // 15分グリッド外
      courseId: shortCourseId,
      sessionId: newSession(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("slot_gone");
  });
});

describe("確定 confirmReservation と楽観ロック（spec 4章・6章・15章）", () => {
  async function holdFirstSlot(optionIds: string[] = []): Promise<{
    reservationId: string;
    version: number;
    sessionId: string;
    startAtISO: string;
  }> {
    const res = await getTherapistSlots({
      slug: "aoi",
      dateISO: tomorrow,
      courseId: shortCourseId,
      optionIds,
    });
    const startAtISO = res!.slots[0]!.startAtISO;
    const sessionId = newSession();
    const hold = await createHold({
      slug: "aoi",
      dateISO: tomorrow,
      startAtISO,
      courseId: shortCourseId,
      optionIds,
      sessionId,
    });
    expect(hold.ok).toBe(true);
    if (!hold.ok) throw new Error("hold failed");
    createdReservations.push(hold.reservationId);
    return { reservationId: hold.reservationId, version: hold.version, sessionId, startAtISO };
  }

  it("held → confirmed に遷移し、version が上がり、顧客・住所・スナップショットが残る", async () => {
    const { reservationId, version, sessionId } = await holdFirstSlot([ext30Id]);
    const phone = `${TEST_PHONE_PREFIX}001`;
    const res = await confirmReservation({
      reservationId,
      sessionId,
      version,
      customerName: "テスト太郎",
      customerPhone: phone,
      addressDetail: "国分町テスト町0-0-0 テストマンション101",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(version + 1);

    const rows = await sql<
      {
        status: string;
        version: number;
        customer_id: string | null;
        address_id: string | null;
        total_amount: number;
      }[]
    >`
      select status, version, customer_id, address_id, total_amount
      from reservations where id = ${reservationId}::uuid
    `;
    expect(rows[0]?.status).toBe("confirmed");
    expect(rows[0]?.version).toBe(version + 1);
    expect(rows[0]?.customer_id).not.toBeNull();
    expect(rows[0]?.address_id).not.toBeNull();

    // 顧客は電話番号で名寄せ（spec 9章）
    const customers = await sql<{ id: string; name: string }[]>`
      select id, name from customers where phone = ${phone}
    `;
    expect(customers.length).toBe(1);
    expect(customers[0]?.name).toBe("テスト太郎");

    // reservation_options スナップショット（spec 3-4: 価格・時間・バックの控え）
    const snap = await sql<
      { price_snapshot: number; duration_snapshot: number; back_value_snapshot: number }[]
    >`
      select price_snapshot, duration_snapshot, back_value_snapshot
      from reservation_options where reservation_id = ${reservationId}::uuid
    `;
    expect(snap.length).toBe(1);
    const option = await sql<{ price: number; duration_min: number }[]>`
      select price, duration_min from options where id = ${ext30Id}::uuid
    `;
    expect(snap[0]?.price_snapshot).toBe(option[0]?.price);
    expect(snap[0]?.duration_snapshot).toBe(option[0]?.duration_min);

    // 合計にはコース + オプションが入っている（金額は整数円）
    expect(Number.isInteger(rows[0]?.total_amount)).toBe(true);
    expect(rows[0]!.total_amount).toBeGreaterThan(0);

    // ホールド追跡行は消えている
    const holds = await sql<{ n: string }[]>`
      select count(*)::text as n from slot_holds
      where reservation_id = ${reservationId}::uuid
    `;
    expect(Number(holds[0]?.n)).toBe(0);
  });

  it("★楽観ロック: 古い version での保存が拒否される（version_conflict）", async () => {
    const { reservationId, version, sessionId } = await holdFirstSlot();
    const res = await confirmReservation({
      reservationId,
      sessionId,
      version: version + 7, // 古い/ズレた version
      customerName: "テスト花子",
      customerPhone: `${TEST_PHONE_PREFIX}002`,
      addressDetail: "国分町テスト町1-1-1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("version_conflict");
    // 予約は held のまま残る（ロールバック）
    const rows = await sql<{ status: string; customer_id: string | null }[]>`
      select status, customer_id from reservations where id = ${reservationId}::uuid
    `;
    expect(rows[0]?.status).toBe("held");
    expect(rows[0]?.customer_id).toBeNull();
    // 顧客・住所もロールバックされている（片肺の書き込みを残さない）
    const customers = await sql<{ n: string }[]>`
      select count(*)::text as n from customers where phone = ${TEST_PHONE_PREFIX + "002"}
    `;
    expect(Number(customers[0]?.n)).toBe(0);
  });

  it("楽観ロック（SQL レベル）: version 一致の update だけが行を更新する", async () => {
    const id = await insertReservation(sql, {
      therapistId: renId,
      departISO: `${tomorrow}T08:00:00.000Z`,
      freeISO: `${tomorrow}T09:00:00.000Z`,
    });
    const first = await sql<{ version: number }[]>`
      update reservations set version = version + 1
      where id = ${id}::uuid and version = 0
      returning version
    `;
    expect(first.length).toBe(1);
    expect(first[0]?.version).toBe(1);
    // 同じ「version = 0」を前提にした保存は 0 行更新 = 拒否
    const stale = await sql<{ version: number }[]>`
      update reservations set version = version + 1
      where id = ${id}::uuid and version = 0
      returning version
    `;
    expect(stale.length).toBe(0);
  });

  it("session が違うと確定できない（hold_not_found）", async () => {
    const { reservationId, version } = await holdFirstSlot();
    const res = await confirmReservation({
      reservationId,
      sessionId: newSession(), // 他人のセッション
      version,
      customerName: "テスト次郎",
      customerPhone: `${TEST_PHONE_PREFIX}003`,
      addressDetail: "国分町テスト町2-2-2",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("hold_not_found");
  });

  it("期限切れホールドは確定できない", async () => {
    const { reservationId, version, sessionId } = await holdFirstSlot();
    await sql`
      update slot_holds set expires_at = now() - interval '1 second'
      where reservation_id = ${reservationId}::uuid
    `;
    const res = await confirmReservation({
      reservationId,
      sessionId,
      version,
      customerName: "テスト三郎",
      customerPhone: `${TEST_PHONE_PREFIX}004`,
      addressDetail: "国分町テスト町3-3-3",
    });
    expect(res.ok).toBe(false);
    // 冒頭の release_expired_holds で行ごと消えるため hold_not_found、
    // 競合タイミングによっては hold_expired（どちらも確定不可で正しい）
    if (!res.ok) expect(["hold_not_found", "hold_expired"]).toContain(res.error);
  });
});

describe("ファネル計測（付録B-2 / 完了条件「離脱地点が計測される」）", () => {
  it("hold / confirm がトランザクション内で記録される", async () => {
    const res = await getTherapistSlots({
      slug: "aoi",
      dateISO: tomorrow,
      courseId: shortCourseId,
    });
    const startAtISO = res!.slots[0]!.startAtISO;
    const sessionId = newSession();
    const hold = await createHold({
      slug: "aoi",
      dateISO: tomorrow,
      startAtISO,
      courseId: shortCourseId,
      sessionId,
    });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    createdReservations.push(hold.reservationId);
    await confirmReservation({
      reservationId: hold.reservationId,
      sessionId,
      version: hold.version,
      customerName: "テスト計測",
      customerPhone: `${TEST_PHONE_PREFIX}005`,
      addressDetail: "国分町テスト町4-4-4",
    });

    const steps = await sql<{ step: string }[]>`
      select step::text from funnel_events
      where session_id = ${sessionId}
      order by occurred_at asc
    `;
    expect(steps.map((s) => s.step)).toEqual(["hold", "confirm"]);
  });

  it("visit / view_therapist / select_slot を記録でき、離脱ならそこで途切れる", async () => {
    const sessionId = newSession();
    await recordFunnelEvent({ sessionId, step: "visit" });
    await recordFunnelEvent({ sessionId, step: "view_therapist", therapistId: aoiId });
    await recordFunnelEvent({
      sessionId,
      step: "select_slot",
      therapistId: aoiId,
      meta: { startAt: `${tomorrow}T03:00:00.000Z` },
    });
    const steps = await sql<{ step: string; therapist_id: string | null; t: string }[]>`
      select step::text, therapist_id, jsonb_typeof(meta) as t
      from funnel_events
      where session_id = ${sessionId}
      order by occurred_at asc
    `;
    expect(steps.map((s) => s.step)).toEqual(["visit", "view_therapist", "select_slot"]);
    expect(steps[1]?.therapist_id).toBe(aoiId);
    // meta は jsonb object（二重エンコードしていない）
    expect(steps[2]?.t).toBe("object");
  });

  it("不正な sessionId（短すぎ）は記録されない", async () => {
    const ok = await recordFunnelEvent({ sessionId: "x", step: "visit" });
    expect(ok).toBe(false);
  });
});

describe("RLS（spec 15章「セラピストが他人の顧客住所を取得できない」）", () => {
  /** ren の確定予約（顧客・住所つき）を superuser 経路で用意する */
  async function makeConfirmedFor(
    therapistId: string,
    phone: string,
    startOverride?: Date,
  ): Promise<{ reservationId: string; addressId: string }> {
    const customer = await sql<{ id: string }[]>`
      insert into customers (phone, name) values (${phone}, 'RLS テスト顧客')
      on conflict (phone) do update set name = excluded.name
      returning id
    `;
    const address = await sql<{ id: string }[]>`
      insert into addresses (customer_id, kind, detail, area_id)
      values (${customer[0]!.id}::uuid, 'home', 'RLS テスト住所', ${shibuyaId}::uuid)
      returning id
    `;
    const start = startOverride ?? new Date(`${tomorrow}T10:00:00.000Z`);
    const rid = await sql<{ id: string }[]>`
      insert into reservations (
        therapist_id, customer_id, address_id, area_id, course_id,
        start_at, end_at, depart_at, free_at,
        travel_in_min, travel_out_min, buffer_min, status,
        nomination_fee, transport_fee, total_amount
      ) values (
        ${therapistId}::uuid, ${customer[0]!.id}::uuid, ${address[0]!.id}::uuid,
        ${shibuyaId}::uuid, ${shortCourseId}::uuid,
        ${start}, ${new Date(start.getTime() + 60 * 60_000)},
        ${new Date(start.getTime() - 30 * 60_000)}, ${new Date(start.getTime() + 90 * 60_000)},
        10, 10, 25, 'confirmed', 0, 0, 10000
      )
      returning id
    `;
    createdReservations.push(rid[0]!.id);
    return { reservationId: rid[0]!.id, addressId: address[0]!.id };
  }

  it("therapist（aoi 紐付け）は他人（ren）の予約・住所・顧客が見えない", async () => {
    await makeConfirmedFor(renId, `${TEST_PHONE_PREFIX}101`);
    const me = sessionOf("therapist"); // seed で aoi に紐付け済み
    const { reservations, addresses, customers } = await withUser(sql, me, async (tx) => {
      const reservations = await tx<{ id: string }[]>`select id from reservations`;
      const addresses = await tx<{ id: string }[]>`select id from addresses`;
      const customers = await tx<{ id: string }[]>`select id from customers`;
      return { reservations, addresses, customers };
    });
    expect(reservations.length).toBe(0);
    expect(addresses.length).toBe(0);
    expect(customers.length).toBe(0);
  });

  it("therapist は自分の担当予約だけ見え、住所は開始180分前から（spec 13-3 / 0012 で精緻化）", async () => {
    await makeConfirmedFor(renId, `${TEST_PHONE_PREFIX}102`);
    // 明日 10:00 = 180分ゲート外（予約自体は見えるが住所はまだ見えない）
    await makeConfirmedFor(aoiId, `${TEST_PHONE_PREFIX}103`);
    // 開始60分後 = ゲート内（住所が見える）
    const soon = await makeConfirmedFor(
      aoiId,
      `${TEST_PHONE_PREFIX}106`,
      new Date(Date.now() + 60 * 60_000),
    );
    const me = sessionOf("therapist");
    const { reservations, addresses, customers } = await withUser(sql, me, async (tx) => {
      const reservations = await tx<{ id: string; therapist_id: string }[]>`
        select id, therapist_id from reservations
      `;
      const addresses = await tx<{ id: string }[]>`select id from addresses`;
      // 電話番号の列制御（spec 7-3）: customers 直接 select は 0 行。
      // 顧客情報は phone 列を持たない customers_therapist_view 経由のみ
      const customers = await tx<{ id: string }[]>`select id from customers`;
      return { reservations, addresses, customers };
    });
    expect(reservations.length).toBe(2);
    expect(reservations.every((r) => r.therapist_id === aoiId)).toBe(true);
    expect(addresses.map((a) => a.id)).toEqual([soon.addressId]);
    expect(customers.length).toBe(0);
  });

  it("reception は予約・顧客・住所を全件参照できる（電話受付）", async () => {
    await makeConfirmedFor(renId, `${TEST_PHONE_PREFIX}104`);
    const rows = await withUser(sql, sessionOf("reception"), async (tx) => {
      return tx<{ id: string }[]>`select id from reservations`;
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("therapist は自分の予約でも金額は更新できない（0012 トリガが 42501 で拒否）", async () => {
    const own = await makeConfirmedFor(aoiId, `${TEST_PHONE_PREFIX}105`);
    // フェーズ14 で status 前進用の update ポリシーが付いたため、行スコープは通るが
    // 列 allow-list トリガ（reservations_therapist_guard）が金額変更を拒否する
    await expect(
      withUser(sql, sessionOf("therapist"), async (tx) => {
        await tx`
          update reservations set total_amount = 0
          where id = ${own.reservationId}::uuid
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("funnel_events は owner/admin だけが読める（therapist は 0 件）", async () => {
    const sessionId = newSession();
    await recordFunnelEvent({ sessionId, step: "visit" });
    const asAdmin = await withUser(sql, sessionOf("admin"), async (tx) => {
      return tx<{ id: string }[]>`
        select id from funnel_events where session_id = ${sessionId}
      `;
    });
    expect(asAdmin.length).toBe(1);
    const asTherapist = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`
        select id from funnel_events where session_id = ${sessionId}
      `;
    });
    expect(asTherapist.length).toBe(0);
    // 追記専用: admin でも update は grant なしで拒否される
    await expect(
      withUser(sql, sessionOf("admin"), async (tx) => {
        await tx`update funnel_events set step = 'confirm' where session_id = ${sessionId}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
