import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import {
  earnPointsCore,
  expirePointsCore,
  getPointBalanceCore,
  listExpiringPointsCore,
  spendPointsCore,
} from "@/lib/points/queries";
import { addHandoverNoteCore, getHandoverNotesCore } from "@/lib/handover/queries";

/**
 * フェーズ16 統合テスト（実 Postgres 必須 / migrations 0014 適用済み前提）。
 *
 * 検証観点（発注指示）:
 * (a) earn → balance 反映（cached_points トリガ含む）
 * (b) FIFO 消費（古いロットから・跨ぎの内訳）
 * (c) 期限切れロットは消費対象外 + expire バッチで落ちる
 * (d) 利用の上限/下限
 * (e) 電話番号でも残高が引ける（完了条件 L1105）
 * (f) point_entries の update/delete が permission denied（追記専用）
 * (g) handover: 次回担当の therapist だけ見える・他セラピストは 0 行（受入 L1123）
 * (h) 指名NG 組合せの予約が DB 層で拒否される（spec L808）
 *
 * 前提: pnpm db:reset 済み。seed の aoi / ren を使う。
 * 予約は他テストと衝突しないよう +14日以降に置く（exclusion 制約対策）。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const THERAPIST_AOI_USER = "aaaaaaaa-0000-4000-8000-000000000004";
const THERAPIST_REN_USER = "aaaaaaaa-0000-4000-8000-000000000005";
const OWNER_USER = "aaaaaaaa-0000-4000-8000-000000000001";
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";

const ownerSession: Session = { userId: OWNER_USER, role: "owner" };
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };
let aoiSession: Session;
let renSession: Session;

const PHONE_MAIN = "0903333" + String(Date.now()).slice(-4);
const PHONE_NG = "0904444" + String(Date.now()).slice(-4);

let aoiId: string;
let renId: string;
let customerId: string; // ポイント/handover 用
let ngCustomerId: string; // 指名NG 用
let addressId: string;
let areaId: string;
let courseId: string;

const resIds: string[] = [];

/** 予約を superuser 経路で直接挿入（他テストと同じヘルパ方式・RLS 素通り） */
async function insertReservation(params: {
  therapistId: string;
  customerId: string | null;
  status: string;
  /** 現在時刻からの分オフセット（施術開始） */
  startOffsetMin: number;
}): Promise<string> {
  const start = new Date(Date.now() + params.startOffsetMin * 60_000);
  const end = new Date(start.getTime() + 60 * 60_000);
  const depart = new Date(start.getTime() - 20 * 60_000);
  const free = new Date(end.getTime() + 20 * 60_000);
  const rows = await sql<{ id: string }[]>`
    insert into reservations
      (therapist_id, customer_id, address_id, area_id, course_id,
       start_at, end_at, depart_at, free_at,
       travel_in_min, travel_out_min, buffer_min, status, total_amount)
    values
      (${params.therapistId}::uuid, ${params.customerId}::uuid, ${
        params.customerId ? addressId : null
      }::uuid, ${areaId}::uuid, ${courseId}::uuid,
       ${start}, ${end}, ${depart}, ${free},
       20, 20, 0, ${params.status}::reservation_status, 12000)
    returning id
  `;
  const id = rows[0]!.id;
  resIds.push(id);
  return id;
}

beforeAll(async () => {
  const therapists = await sql<{ id: string; slug: string }[]>`
    select id, slug from therapists where slug in ('aoi', 'ren')
  `;
  aoiId = therapists.find((t) => t.slug === "aoi")?.id ?? "";
  renId = therapists.find((t) => t.slug === "ren")?.id ?? "";
  if (!aoiId || !renId) throw new Error("seed に aoi/ren が見つかりません");
  aoiSession = { userId: THERAPIST_AOI_USER, role: "therapist", therapistId: aoiId };
  renSession = { userId: THERAPIST_REN_USER, role: "therapist", therapistId: renId };

  const c1 = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE_MAIN}, 'フェーズ16顧客')
    returning id
  `;
  customerId = c1[0]!.id;
  const c2 = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE_NG}, 'フェーズ16NG顧客')
    returning id
  `;
  ngCustomerId = c2[0]!.id;

  const areaRows = await sql<{ id: string }[]>`select id from areas limit 1`;
  areaId = areaRows[0]!.id;
  const courseRows = await sql<{ id: string }[]>`
    select id from courses where is_active = true limit 1
  `;
  courseId = courseRows[0]!.id;

  const aRows = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id)
    values (${customerId}::uuid, 'home', 'フェーズ16テスト住所', ${areaId}::uuid)
    returning id
  `;
  addressId = aRows[0]!.id;
});

afterAll(async () => {
  // point_entries → customers は on delete restrict のため先に台帳を消す
  // （superuser は BYPASSRLS・追記専用は app_runtime に対する制約）
  await sql`delete from point_entries where customer_id in (${customerId}::uuid, ${ngCustomerId}::uuid)`;
  if (resIds.length > 0) {
    await sql`delete from reservations where id = any(${resIds}::uuid[])`;
  }
  await sql`delete from addresses where id = ${addressId}::uuid`;
  await sql`delete from customers where id in (${customerId}::uuid, ${ngCustomerId}::uuid)`;
  await sql.end({ timeout: 5 });
});

// =====================================================================
// ポイント台帳
// =====================================================================
describe("point_entries: 追記専用台帳", () => {
  it("(a) earn が残高と cached_points に反映される", async () => {
    const r = await earnPointsCore(sql, ownerSession, {
      customerId,
      points: 300,
      reason: "test-lot-1",
    });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.balance).toBe(300);

    const bal = await getPointBalanceCore(sql, receptionSession, { customerId });
    expect(bal).toEqual({ kind: "ok", customerId, balance: 300 });

    const cached = await sql<{ cached_points: number }[]>`
      select cached_points from customers where id = ${customerId}::uuid
    `;
    expect(cached[0]!.cached_points).toBe(300);
  });

  it("(b) FIFO: 古いロットから消費され、跨ぐと内訳が分かれる", async () => {
    // 2つ目のロット（新しい）
    const r2 = await earnPointsCore(sql, ownerSession, {
      customerId,
      points: 400,
      reason: "test-lot-2",
    });
    expect(r2.kind).toBe("ok");

    const used = await spendPointsCore(sql, receptionSession, {
      customerId,
      requestedPoints: 350,
    });
    expect(used.kind).toBe("ok");
    if (used.kind === "ok") {
      expect(used.used).toBe(350);
      // lot-1(300) を使い切り、lot-2 から 50
      expect(used.consumption).toHaveLength(2);
      expect(used.consumption[0]!.amount).toBe(300);
      expect(used.consumption[1]!.amount).toBe(50);
      expect(used.balance).toBe(350);
    }

    // 台帳: use 行がロットごとに1行・負で残る
    const useRows = await sql<{ points: number; lot_id: string }[]>`
      select points, lot_id::text as lot_id from point_entries
      where customer_id = ${customerId}::uuid and type = 'use'
      order by lot_id
    `;
    expect(useRows.map((r) => r.points)).toEqual([-300, -50]);
  });

  it("(c) 期限切れロットは消費対象外・expire バッチで残高から落ちる", async () => {
    // 期限切れロットを直接挿入（superuser。トリガで cached_points も増える）
    await sql`
      insert into point_entries (customer_id, type, points, reason, expires_at, occurred_at)
      values (${customerId}::uuid, 'earn', 1000, 'test-expired-lot',
              now() - interval '1 day', now() - interval '100 days')
    `;
    // 残高上は +1000 だが、期限内の消費可能は 350 のまま → 400 は不足
    const tooMuch = await spendPointsCore(sql, receptionSession, {
      customerId,
      requestedPoints: 400,
    });
    expect(tooMuch).toEqual({ kind: "insufficient", available: 350 });

    // 失効バッチ: 期限切れ 1000P が expire 行（負）で相殺される
    const expired = await expirePointsCore(sql, ownerSession);
    expect(expired.expiredLotCount).toBe(1);
    expect(expired.expiredPoints).toBe(1000);

    const bal = await getPointBalanceCore(sql, ownerSession, { customerId });
    expect(bal).toEqual({ kind: "ok", customerId, balance: 350 });

    // 二重失効しない（冪等）
    const again = await expirePointsCore(sql, ownerSession);
    expect(again.expiredLotCount).toBe(0);
  });

  it("(d) 利用の下限・上限が効く", async () => {
    const below = await spendPointsCore(sql, receptionSession, {
      customerId,
      requestedPoints: 50,
      minUse: 100,
    });
    expect(below).toEqual({ kind: "below_min", min: 100 });

    const above = await spendPointsCore(sql, receptionSession, {
      customerId,
      requestedPoints: 300,
      maxUse: 200,
    });
    expect(above).toEqual({ kind: "above_max", max: 200 });
  });

  it("(e) 電話番号でも残高が引ける（完了条件: 電話注文でも貯まる/使える）", async () => {
    const byPhone = await getPointBalanceCore(sql, receptionSession, {
      phone: PHONE_MAIN,
    });
    expect(byPhone).toEqual({ kind: "ok", customerId, balance: 350 });

    // 電話番号だけで利用もできる
    const used = await spendPointsCore(sql, receptionSession, {
      phone: PHONE_MAIN,
      requestedPoints: 100,
    });
    expect(used.kind).toBe("ok");
    if (used.kind === "ok") expect(used.balance).toBe(250);
  });

  it("(f) update/delete が permission denied（追記専用 / 0010 パターン）", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`update point_entries set reason = 'tampered'
                 where customer_id = ${customerId}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/);

    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`delete from point_entries where customer_id = ${customerId}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("therapist はポイント台帳を読めない（select 0行）・書けない", async () => {
    const rows = await withUser(sql, aoiSession, async (tx) => {
      return tx<{ id: string }[]>`
        select id::text as id from point_entries
        where customer_id = ${customerId}::uuid
      `;
    });
    expect(rows).toHaveLength(0);

    await expect(
      withUser(sql, aoiSession, async (tx) => {
        await tx`insert into point_entries (customer_id, type, points)
                 values (${customerId}::uuid, 'earn', 100)`;
      }),
    ).rejects.toThrow(); // RLS insert ポリシー違反
  });

  it("存在しない顧客・不正入力", async () => {
    const notFound = await getPointBalanceCore(sql, ownerSession, {
      phone: "0999999999",
    });
    expect(notFound).toEqual({ kind: "customer_not_found" });

    const invalid = await earnPointsCore(sql, ownerSession, {
      customerId,
      points: 0,
    });
    expect(invalid).toEqual({ kind: "invalid" });
  });

  it("listExpiringPoints: 30日以内に失効するロットが載る", async () => {
    await earnPointsCore(sql, ownerSession, {
      customerId,
      points: 77,
      reason: "test-expiring-soon",
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // 10日後
    });
    const items = await listExpiringPointsCore(sql, ownerSession, { withinDays: 30 });
    const mine = items.filter((i) => i.customerId === customerId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.remaining).toBe(77);
    expect(mine[0]!.phone).toBe(PHONE_MAIN);
  });
});

// =====================================================================
// 引き継ぎメモ（受入 L1123）
// =====================================================================
describe("handover_notes: 次回担当にだけ見える", () => {
  let doneResId: string;
  let upcomingResId: string;

  it("担当セラピストが施術完了予約にメモを残せる", async () => {
    doneResId = await insertReservation({
      therapistId: aoiId,
      customerId,
      status: "done",
      startOffsetMin: 14 * 24 * 60, // +14日（他テストの枠と衝突しない位置）
    });
    const added = await addHandoverNoteCore(sql, aoiSession, {
      reservationId: doneResId,
      body: "圧は強め希望。到着時はインターホンではなく電話。",
    });
    expect(added.kind).toBe("ok");
  });

  it("次回の担当予約が無い間は本人にも見えない（次回予約で表示される設計）", async () => {
    const notes = await getHandoverNotesCore(sql, aoiSession, { customerId });
    expect(notes).toHaveLength(0);
  });

  it("次回予約（confirmed）が入ると次回担当のセラピストにだけ見える", async () => {
    upcomingResId = await insertReservation({
      therapistId: aoiId,
      customerId,
      status: "confirmed",
      startOffsetMin: 15 * 24 * 60, // +15日
    });

    const aoiNotes = await getHandoverNotesCore(sql, aoiSession, { customerId });
    expect(aoiNotes).toHaveLength(1);
    expect(aoiNotes[0]!.body).toContain("圧は強め");

    // 無関係のセラピスト（ren）には 0 行（受入 L1123）
    const renNotes = await getHandoverNotesCore(sql, renSession, { customerId });
    expect(renNotes).toHaveLength(0);

    // staff は全件見える（電話受付の確認用）
    const staffNotes = await getHandoverNotesCore(sql, receptionSession, { customerId });
    expect(staffNotes).toHaveLength(1);
  });

  it("担当外の予約にはメモを書けない（RLS スコープ外 = not found）", async () => {
    const added = await addHandoverNoteCore(sql, renSession, {
      reservationId: doneResId,
      body: "他人の予約に書けてはいけない",
    });
    expect(added.kind).toBe("reservation_not_found");
  });

  it("完了前（confirmed）の予約にはまだ書けない", async () => {
    const added = await addHandoverNoteCore(sql, aoiSession, {
      reservationId: upcomingResId,
      body: "まだ施術していない",
    });
    expect(added.kind).toBe("not_completed");
  });

  it("staff セッションでは代筆できない（authorship 保護）", async () => {
    const added = await addHandoverNoteCore(sql, ownerSession, {
      reservationId: doneResId,
      body: "staff の代筆",
    });
    expect(added.kind).toBe("forbidden");
  });
});

// =====================================================================
// 指名NG（spec L808）
// =====================================================================
describe("customer_therapist_ng: NG 組合せは DB 層で予約不可", () => {
  it("staff が NG を登録でき、その組合せの予約 insert がトリガで拒否される", async () => {
    await withUser(sql, receptionSession, async (tx) => {
      await tx`
        insert into customer_therapist_ng (customer_id, therapist_id, reason, created_by)
        values (${ngCustomerId}::uuid, ${renId}::uuid, 'テストNG', ${RECEPTION_USER}::uuid)
      `;
    });

    // NG 組合せ（ren × ngCustomer）は superuser 直 insert でも拒否される
    await expect(
      insertReservation({
        therapistId: renId,
        customerId: ngCustomerId,
        status: "confirmed",
        startOffsetMin: 16 * 24 * 60,
      }),
    ).rejects.toThrow(/customer_therapist_ng_blocked/);

    // NG でない組合せ（aoi × ngCustomer）は通る
    const okId = await insertReservation({
      therapistId: aoiId,
      customerId: ngCustomerId,
      status: "confirmed",
      startOffsetMin: 17 * 24 * 60,
    });
    expect(okId).toBeTruthy();
  });

  it("既存予約への customer_id 付け替えも拒否される", async () => {
    const heldId = await insertReservation({
      therapistId: renId,
      customerId: null,
      status: "held",
      startOffsetMin: 18 * 24 * 60,
    });
    await expect(
      sql`update reservations
          set customer_id = ${ngCustomerId}::uuid
          where id = ${heldId}::uuid`,
    ).rejects.toThrow(/customer_therapist_ng_blocked/);
  });

  it("therapist_courses: 個別指名料の上書き行を持てる（フェーズ18 で参照）", async () => {
    await withUser(sql, ownerSession, async (tx) => {
      await tx`
        insert into therapist_courses (therapist_id, course_id, is_available, nomination_fee)
        values (${aoiId}::uuid, ${courseId}::uuid, true, 2000)
        on conflict (therapist_id, course_id)
        do update set nomination_fee = excluded.nomination_fee
      `;
    });
    const rows = await sql<{ nomination_fee: number | null }[]>`
      select nomination_fee from therapist_courses
      where therapist_id = ${aoiId}::uuid and course_id = ${courseId}::uuid
    `;
    expect(rows[0]!.nomination_fee).toBe(2000);
    await sql`delete from therapist_courses
              where therapist_id = ${aoiId}::uuid and course_id = ${courseId}::uuid`;
  });
});
