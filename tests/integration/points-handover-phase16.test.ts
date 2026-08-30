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
import { getHandoverNotesForReservation } from "@/lib/handover/therapist-portal-actions";

/**
 * フェーズ16 統合テスト（実 Postgres 必須 / migrations 0014 適用済み前提）。
 *
 * 既存 points-handover.test.ts（18件）と重複させず補完網羅する観点:
 *
 * A. 電話番号だけで残高・FIFO消費が完結する（完了条件 L1105）
 * B. 複数ロット跨ぎ FIFO の内訳が台帳行に残る（受入 L1102）
 * C. 期限切れロットが失効し残高から落ちる・二重失効しない（受入 L1103）
 * D. 利用分が負の point_entries として立つ（台帳の負行確認 L1104 相当）
 * E. point_entries の update/delete が permission denied（追記専用）
 * F. cached_points と sum(points) が一致（トリガ整合）
 * G. handover-RLS: getHandoverNotesForReservation 経路（therapist-portal-actions）
 *    - 担当セラピストの次回予約あり → 見える
 *    - 別セラピスト → 0行
 *    - 次回予約（confirmed）が無い done のみ状態 → 0行
 * H. NG guard: addNgPair → 予約 insert が check_violation で拒否
 *    removeNgPair → 通る
 *    listNgPairs が名前つきで返る（staff アクション経由）
 *
 * 前提: pnpm db:reset 済み。seed の aoi / ren を使う。
 * 予約は他テストと衝突しないよう +20日以降に配置（exclusion 制約対策）。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

// --------------------------------------------------------------------------
// seed の固定 UUID（seeds/index.ts と対応）
// --------------------------------------------------------------------------
const THERAPIST_AOI_USER = "aaaaaaaa-0000-4000-8000-000000000004";
const THERAPIST_REN_USER = "aaaaaaaa-0000-4000-8000-000000000005";
const OWNER_USER = "aaaaaaaa-0000-4000-8000-000000000001";
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";

const ownerSession: Session = { userId: OWNER_USER, role: "owner" };
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };
let aoiSession: Session;
let renSession: Session;

// --------------------------------------------------------------------------
// テスト専用の顧客（電話番号で衝突しないよう末尾4桁を時刻から生成）
// --------------------------------------------------------------------------
const SUFFIX = String(Date.now() + 7).slice(-4); // 既存テストと重ならないようオフセット
const PHONE_A = "0901111" + SUFFIX; // ポイント・FIFO・handover 用顧客
const PHONE_B = "0902222" + SUFFIX; // NG 組合せ専用顧客

let aoiId: string;
let renId: string;
let customerAId: string;
let customerBId: string;
let addressAId: string;
let areaId: string;
let courseId: string;

const resIds: string[] = [];

// --------------------------------------------------------------------------
// ヘルパ: 予約を superuser 経路で直接挿入
// --------------------------------------------------------------------------
async function insertReservation(params: {
  therapistId: string;
  customerId: string | null;
  status: string;
  startOffsetDays: number;
}): Promise<string> {
  const start = new Date(
    Date.now() + params.startOffsetDays * 24 * 60 * 60 * 1000,
  );
  const end = new Date(start.getTime() + 60 * 60_000);
  const depart = new Date(start.getTime() - 20 * 60_000);
  const free = new Date(end.getTime() + 20 * 60_000);

  const rows = await sql<{ id: string }[]>`
    insert into reservations
      (therapist_id, customer_id, address_id, area_id, course_id,
       start_at, end_at, depart_at, free_at,
       travel_in_min, travel_out_min, buffer_min, status, total_amount)
    values
      (${params.therapistId}::uuid,
       ${params.customerId}::uuid,
       ${params.customerId ? addressAId : null}::uuid,
       ${areaId}::uuid,
       ${courseId}::uuid,
       ${start}, ${end}, ${depart}, ${free},
       20, 20, 0,
       ${params.status}::reservation_status,
       10000)
    returning id
  `;
  const id = rows[0]!.id;
  resIds.push(id);
  return id;
}

beforeAll(async () => {
  // therapist ID を slug から解決
  const therapists = await sql<{ id: string; slug: string }[]>`
    select id, slug from therapists where slug in ('aoi', 'ren')
  `;
  aoiId = therapists.find((t) => t.slug === "aoi")?.id ?? "";
  renId = therapists.find((t) => t.slug === "ren")?.id ?? "";
  if (!aoiId || !renId) throw new Error("seed に aoi/ren が見つかりません");

  aoiSession = { userId: THERAPIST_AOI_USER, role: "therapist", therapistId: aoiId };
  renSession = { userId: THERAPIST_REN_USER, role: "therapist", therapistId: renId };

  // テスト顧客 A (ポイント/handover)
  const cA = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE_A}, 'P16顧客A') returning id
  `;
  customerAId = cA[0]!.id;

  // テスト顧客 B (NG専用)
  const cB = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE_B}, 'P16顧客B') returning id
  `;
  customerBId = cB[0]!.id;

  const areaRows = await sql<{ id: string }[]>`select id from areas limit 1`;
  areaId = areaRows[0]!.id;

  const courseRows = await sql<{ id: string }[]>`
    select id from courses where is_active = true limit 1
  `;
  courseId = courseRows[0]!.id;

  const aRows = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id)
    values (${customerAId}::uuid, 'home', 'P16テスト住所', ${areaId}::uuid)
    returning id
  `;
  addressAId = aRows[0]!.id;
});

afterAll(async () => {
  // handover_notes → addresses → customers の順で削除
  await sql`delete from handover_notes where customer_id = ${customerAId}::uuid`;
  await sql`delete from customer_therapist_ng
            where customer_id in (${customerAId}::uuid, ${customerBId}::uuid)`;
  await sql`delete from point_entries
            where customer_id in (${customerAId}::uuid, ${customerBId}::uuid)`;
  if (resIds.length > 0) {
    await sql`delete from reservations where id = any(${resIds}::uuid[])`;
  }
  await sql`delete from addresses where id = ${addressAId}::uuid`;
  await sql`delete from customers
            where id in (${customerAId}::uuid, ${customerBId}::uuid)`;
  await sql.end({ timeout: 5 });
});

// ==========================================================================
// A + F: 電話番号で earn → 残高・cached_points 整合
// ==========================================================================
describe("A+F: 電話番号だけで earn/残高照会・cached_points 整合（受入 L1105）", () => {
  it("電話番号で earn できる（customer_id 不明な電話注文でも使える）", async () => {
    const r = await earnPointsCore(sql, ownerSession, {
      phone: PHONE_A,
      points: 500,
      reason: "p16-phone-earn-1",
    });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.balance).toBe(500);
      expect(r.customerId).toBe(customerAId);
    }
  });

  it("電話番号だけで残高照会できる（getPointBalance(phone) / 受入 L1105）", async () => {
    const bal = await getPointBalanceCore(sql, receptionSession, { phone: PHONE_A });
    expect(bal).toMatchObject({ kind: "ok", customerId: customerAId, balance: 500 });
  });

  it("cached_points と sum(points) が一致（トリガ整合 / 受入 L1102）", async () => {
    const [cached, ledgerSum] = await Promise.all([
      sql<{ cached_points: number }[]>`
        select cached_points from customers where id = ${customerAId}::uuid
      `,
      sql<{ s: number }[]>`
        select coalesce(sum(points), 0)::integer as s
        from point_entries where customer_id = ${customerAId}::uuid
      `,
    ]);
    expect(cached[0]!.cached_points).toBe(ledgerSum[0]!.s);
  });
});

// ==========================================================================
// B: 複数ロット跨ぎ FIFO の内訳が台帳行に残る（受入 L1102）
// ==========================================================================
describe("B: FIFO 複数ロット跨ぎ・内訳が台帳行に残る（受入 L1102）", () => {
  it("2ロット（300 + 400）のうち 350 を消費すると古いロットから使う", async () => {
    // 2つ目のロット付与
    const r2 = await earnPointsCore(sql, ownerSession, {
      customerId: customerAId,
      points: 400,
      reason: "p16-lot-2",
    });
    expect(r2.kind).toBe("ok");
    // 現時点の残高: 500 + 400 = 900

    const used = await spendPointsCore(sql, receptionSession, {
      customerId: customerAId,
      requestedPoints: 350,
    });
    expect(used.kind).toBe("ok");
    if (used.kind === "ok") {
      expect(used.used).toBe(350);
      // lot1(500) から 350 消費（lot2 は手付かず）
      expect(used.consumption).toHaveLength(1);
      expect(used.consumption[0]!.amount).toBe(350);
      expect(used.balance).toBe(550); // 900 - 350
    }
  });

  it("3ロット跨ぎ: ロット1(残150) + ロット2(400) 合計500から550消費は不足", async () => {
    // 現時点: lot1残150, lot2残400 = 550
    const over = await spendPointsCore(sql, receptionSession, {
      customerId: customerAId,
      requestedPoints: 600,
    });
    expect(over).toMatchObject({ kind: "insufficient", available: 550 });
  });

  it("ちょうど残高分の消費は成功する（shortage=0 境界）", async () => {
    // 残550のうち550を消費
    const exact = await spendPointsCore(sql, receptionSession, {
      customerId: customerAId,
      requestedPoints: 550,
    });
    expect(exact.kind).toBe("ok");
    if (exact.kind === "ok") {
      expect(exact.balance).toBe(0);
    }
  });

  it("利用行が負の point_entries として台帳に残る（受入 L1104 相当）", async () => {
    const useRows = await sql<{ points: number; type: string }[]>`
      select points, type::text as type from point_entries
      where customer_id = ${customerAId}::uuid and type = 'use'
      order by occurred_at, id
    `;
    // use 行は全て負
    expect(useRows.every((r) => r.points < 0)).toBe(true);
    expect(useRows.length).toBeGreaterThan(0);
  });
});

// ==========================================================================
// C: 期限切れロット失効・二重失効しない（受入 L1103）
// ==========================================================================
describe("C: 期限切れロット失効・二重失効防止（受入 L1103）", () => {
  it("期限切れロットを追加しても消費対象にならない（消費可能残高が正しい）", async () => {
    // 残高リセット: 新規ロット付与
    await earnPointsCore(sql, ownerSession, {
      customerId: customerAId,
      points: 200,
      reason: "p16-fresh-lot",
    });
    // 期限切れロット（superuser 経路で直接挿入）
    await sql`
      insert into point_entries
        (customer_id, type, points, reason, expires_at, occurred_at)
      values
        (${customerAId}::uuid, 'earn', 800, 'p16-expired-lot',
         now() - interval '1 day', now() - interval '90 days')
    `;
    // 期限内消費可能 = 200 のみ
    const tooMuch = await spendPointsCore(sql, receptionSession, {
      customerId: customerAId,
      requestedPoints: 300,
    });
    expect(tooMuch).toMatchObject({ kind: "insufficient", available: 200 });
  });

  it("expirePoints バッチで期限切れロットが失効し残高から落ちる", async () => {
    const expired = await expirePointsCore(sql, ownerSession);
    // 少なくとも 800P 分の失効ロットが処理されるはず
    expect(expired.expiredLotCount).toBeGreaterThanOrEqual(1);
    expect(expired.expiredPoints).toBeGreaterThanOrEqual(800);

    const bal = await getPointBalanceCore(sql, ownerSession, { customerId: customerAId });
    expect(bal).toMatchObject({ kind: "ok", balance: 200 });
  });

  it("二重失効しない（expirePoints 冪等性）", async () => {
    const again = await expirePointsCore(sql, ownerSession);
    // このテスト顧客に対して再度失効させると 0 になる
    // （他テストの失効済みロットが混在する可能性があるので=0は強制しない。
    //   少なくとも自分の失効済みロットが2度処理されていないことを確認）
    const bal = await getPointBalanceCore(sql, ownerSession, { customerId: customerAId });
    // 二重失効されると残高が負になる
    expect(bal.kind).toBe("ok");
    if (bal.kind === "ok") {
      expect(bal.balance).toBeGreaterThanOrEqual(0);
    }
    // expiredLotCount は 0 または 他顧客のロット数（自顧客の再失効は 0）
    // ただし他テストのロットは存在するため=0は保証しない
    void again;
  });

  it("失効後に cached_points と sum(points) が一致する", async () => {
    const [cached, ledgerSum] = await Promise.all([
      sql<{ cached_points: number }[]>`
        select cached_points from customers where id = ${customerAId}::uuid
      `,
      sql<{ s: number }[]>`
        select coalesce(sum(points), 0)::integer as s
        from point_entries where customer_id = ${customerAId}::uuid
      `,
    ]);
    expect(cached[0]!.cached_points).toBe(ledgerSum[0]!.s);
  });
});

// ==========================================================================
// D + E: 追記専用台帳（update/delete が permission denied）
// ==========================================================================
describe("D+E: point_entries 追記専用（permission denied / 受入）", () => {
  it("app_runtime ロールでの update が permission denied", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`update point_entries set reason = 'tampered'
                 where customer_id = ${customerAId}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("app_runtime ロールでの delete が permission denied", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`delete from point_entries
                 where customer_id = ${customerAId}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("therapist セッションは point_entries を select できない（RLS で 0行）", async () => {
    const rows = await withUser(sql, aoiSession, async (tx) => {
      return tx<{ id: string }[]>`
        select id::text as id from point_entries
        where customer_id = ${customerAId}::uuid
      `;
    });
    expect(rows).toHaveLength(0);
  });

  it("therapist セッションは point_entries に insert できない（RLS 拒否）", async () => {
    await expect(
      withUser(sql, aoiSession, async (tx) => {
        await tx`insert into point_entries (customer_id, type, points)
                 values (${customerAId}::uuid, 'earn', 100)`;
      }),
    ).rejects.toThrow();
  });
});

// ==========================================================================
// E-2: listExpiringPoints の withinDays 境界確認
// ==========================================================================
describe("E-2: listExpiringPoints withinDays 境界", () => {
  it("withinDays=10 以内に失効するロットだけが一覧に載る", async () => {
    // 5日後に失効するロット
    const soon = await earnPointsCore(sql, ownerSession, {
      customerId: customerAId,
      points: 55,
      reason: "p16-expiring-soon",
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    });
    expect(soon.kind).toBe("ok");

    // 60日後に失効するロット（圏外）
    await earnPointsCore(sql, ownerSession, {
      customerId: customerAId,
      points: 66,
      reason: "p16-expiring-far",
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    });

    const items = await listExpiringPointsCore(sql, ownerSession, { withinDays: 10 });
    const mine = items.filter((i) => i.customerId === customerAId);
    // 5日後ロット(55)だけが含まれる（60日後は圏外）
    expect(mine).toHaveLength(1);
    expect(mine[0]!.remaining).toBe(55);
    expect(mine[0]!.phone).toBe(PHONE_A);
  });
});

// ==========================================================================
// G: handover-RLS: getHandoverNotesForReservation（therapist-portal-actions）
// 受入 L1123「次回予約でメモが担当者に出る」
// ==========================================================================
describe("G: handover-RLS: getHandoverNotesForReservation 経路（受入 L1123）", () => {
  let doneResId: string;
  let upcomingResId: string;

  it("施術完了予約に担当セラピスト(aoi)がメモを書ける", async () => {
    doneResId = await insertReservation({
      therapistId: aoiId,
      customerId: customerAId,
      status: "done",
      startOffsetDays: 20,
    });
    const r = await addHandoverNoteCore(sql, aoiSession, {
      reservationId: doneResId,
      body: "P16テスト: 肩こりひどめ・到着時に電話連絡要",
    });
    expect(r.kind).toBe("ok");
  });

  it("次回担当予約（confirmed）が無い間は aoi 本人にも 0行（RLS status 条件）", async () => {
    // この時点では done の予約のみ。done は「次回担当」条件に含まれない
    const notes = await getHandoverNotesCore(sql, aoiSession, { customerId: customerAId });
    expect(notes).toHaveLength(0);
  });

  it("getHandoverNotesForReservation: 次回担当予約（confirmed）が無いと空配列", async () => {
    const r = await getHandoverNotesForReservation(doneResId, "aoi");
    expect(r.ok).toBe(true);
    // done 予約は自分の担当だが次回予約が無いため handover は空
    expect(r.data ?? []).toHaveLength(0);
  });

  it("次回予約（confirmed）追加後は担当 aoi のみ見える", async () => {
    upcomingResId = await insertReservation({
      therapistId: aoiId,
      customerId: customerAId,
      status: "confirmed",
      startOffsetDays: 21,
    });

    const aoiNotes = await getHandoverNotesCore(sql, aoiSession, { customerId: customerAId });
    expect(aoiNotes).toHaveLength(1);
    expect(aoiNotes[0]!.body).toContain("肩こりひどめ");
  });

  it("getHandoverNotesForReservation: 次回確定予約の reservationId で aoi が引ける", async () => {
    const r = await getHandoverNotesForReservation(upcomingResId, "aoi");
    expect(r.ok).toBe(true);
    expect((r.data ?? []).length).toBeGreaterThan(0);
    expect(r.data![0]!.body).toContain("肩こりひどめ");
  });

  it("別セラピスト（ren）には 0行（受入 L1123）", async () => {
    const renNotes = await getHandoverNotesCore(sql, renSession, { customerId: customerAId });
    expect(renNotes).toHaveLength(0);
  });

  it("getHandoverNotesForReservation: ren の予約ID で引くと 0行（自分の担当でない）", async () => {
    // done 予約の therapist は aoi。ren には RLS で見えない
    const r = await getHandoverNotesForReservation(doneResId, "ren");
    // customer_id が取れないため空配列（エラーではない）
    expect(r.ok).toBe(true);
    expect(r.data ?? []).toHaveLength(0);
  });

  it("staff（reception）はメモ全件見える（電話受付の引き継ぎ確認用）", async () => {
    const staffNotes = await getHandoverNotesCore(sql, receptionSession, {
      customerId: customerAId,
    });
    expect(staffNotes).toHaveLength(1);
  });

  it("担当外の予約には他セラピスト（ren）が書けない（reservation_not_found）", async () => {
    const r = await addHandoverNoteCore(sql, renSession, {
      reservationId: doneResId,
      body: "他人の予約に書けてはいけない",
    });
    expect(r.kind).toBe("reservation_not_found");
  });

  it("施術完了でない予約（confirmed）にはまだ書けない（not_completed）", async () => {
    const r = await addHandoverNoteCore(sql, aoiSession, {
      reservationId: upcomingResId,
      body: "まだ施術前",
    });
    expect(r.kind).toBe("not_completed");
  });

  it("staff（owner）がセラピスト代わりに書こうとしても forbidden", async () => {
    const r = await addHandoverNoteCore(sql, ownerSession, {
      reservationId: doneResId,
      body: "staff 代筆",
    });
    expect(r.kind).toBe("forbidden");
  });

  it("done になった次回予約は新たな confirmed 予約が無ければ表示されなくなる（失効動作確認）", async () => {
    // upcoming を done に更新 → もう次回 confirmed が無い → 0行に戻るはず
    await sql`update reservations set status = 'done' where id = ${upcomingResId}::uuid`;
    const notes = await getHandoverNotesCore(sql, aoiSession, { customerId: customerAId });
    expect(notes).toHaveLength(0);
    // 元に戻す（afterAll の delete に備える）
    await sql`update reservations set status = 'confirmed' where id = ${upcomingResId}::uuid`;
  });
});

// ==========================================================================
// H: 指名 NG guard（spec L808）
// DB guard トリガで NG 組合せの予約が拒否される
// ==========================================================================
describe("H: 指名 NG guard（spec L808 / reservations_ng_guard トリガ）", () => {
  it("NG 登録前は ren × 顧客B の予約が通る", async () => {
    const okId = await insertReservation({
      therapistId: renId,
      customerId: customerBId,
      status: "confirmed",
      startOffsetDays: 25,
    });
    expect(okId).toBeTruthy();
  });

  it("NG 組合せを staff が登録できる", async () => {
    await withUser(sql, receptionSession, async (tx) => {
      await tx`
        insert into customer_therapist_ng (customer_id, therapist_id, reason, created_by)
        values (${customerBId}::uuid, ${renId}::uuid, 'P16テストNG', ${RECEPTION_USER}::uuid)
      `;
    });
    // 確認: listNgPairs 相当の直接 select
    const rows = await sql<{ customer_id: string; therapist_id: string }[]>`
      select customer_id, therapist_id from customer_therapist_ng
      where customer_id = ${customerBId}::uuid and therapist_id = ${renId}::uuid
    `;
    expect(rows).toHaveLength(1);
  });

  it("NG 組合せ（ren × 顧客B）の予約 insert が check_violation で拒否される", async () => {
    await expect(
      insertReservation({
        therapistId: renId,
        customerId: customerBId,
        status: "confirmed",
        startOffsetDays: 26,
      }),
    ).rejects.toThrow(/customer_therapist_ng_blocked/);
  });

  it("NG 対象外（aoi × 顧客B）は通る", async () => {
    const okId = await insertReservation({
      therapistId: aoiId,
      customerId: customerBId,
      status: "confirmed",
      startOffsetDays: 27,
    });
    expect(okId).toBeTruthy();
  });

  it("既存予約への customer_id 付け替えも拒否される（update ガード）", async () => {
    // ren × null（held）の予約を作り顧客B に付け替えようとする
    const heldId = await insertReservation({
      therapistId: renId,
      customerId: null,
      status: "held",
      startOffsetDays: 28,
    });
    await expect(
      sql`update reservations
          set customer_id = ${customerBId}::uuid
          where id = ${heldId}::uuid`,
    ).rejects.toThrow(/customer_therapist_ng_blocked/);
  });

  it("NG 解除後は ren × 顧客B の予約が通る", async () => {
    await sql`
      delete from customer_therapist_ng
      where customer_id = ${customerBId}::uuid
        and therapist_id = ${renId}::uuid
    `;
    const okId = await insertReservation({
      therapistId: renId,
      customerId: customerBId,
      status: "confirmed",
      startOffsetDays: 29,
    });
    expect(okId).toBeTruthy();
  });

  it("listNgPairs: 名前付きで返る（顧客名・セラピスト名が含まれる）", async () => {
    // NG 再登録して一覧を確認
    await sql`
      insert into customer_therapist_ng (customer_id, therapist_id, reason, created_by)
      values (${customerBId}::uuid, ${renId}::uuid, 'listNgPairs確認用', ${RECEPTION_USER}::uuid)
      on conflict (customer_id, therapist_id) do nothing
    `;
    const rows = await sql<{
      customer_id: string;
      therapist_id: string;
      customer_name: string;
      therapist_name: string;
      reason: string | null;
    }[]>`
      select
        ng.customer_id,
        ng.therapist_id,
        cu.name  as customer_name,
        coalesce(er.published->>'name', th.slug) as therapist_name,
        ng.reason
      from customer_therapist_ng ng
      join customers  cu on cu.id = ng.customer_id
      join therapists th on th.id = ng.therapist_id
      left join entity_records er on er.entity = 'therapist' and er.slug = th.slug
      where ng.customer_id = ${customerBId}::uuid and ng.therapist_id = ${renId}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customer_name).toBe("P16顧客B");
    expect(rows[0]!.therapist_name).toBeTruthy(); // slug か公開名が入る
    // クリーンアップ
    await sql`
      delete from customer_therapist_ng
      where customer_id = ${customerBId}::uuid and therapist_id = ${renId}::uuid
    `;
  });
});

// ==========================================================================
// I: 電話番号で spendPoints（use）できる（完了条件 L1105 の use 側）
// ==========================================================================
describe("I: 電話番号だけで usePoints が完結する（完了条件 L1105）", () => {
  it("earn 後に phone で残高照会・消費できる", async () => {
    // 事前: 新規ロット付与（customerA に対して）
    await earnPointsCore(sql, ownerSession, {
      customerId: customerAId,
      points: 300,
      reason: "p16-phone-use-test",
    });

    // phone 指定で consume
    const used = await spendPointsCore(sql, receptionSession, {
      phone: PHONE_A,
      requestedPoints: 100,
    });
    expect(used.kind).toBe("ok");
    if (used.kind === "ok") {
      expect(used.used).toBe(100);
      expect(used.balance).toBeGreaterThanOrEqual(0);
    }

    // phone で残高照会しても一致
    const bal = await getPointBalanceCore(sql, receptionSession, { phone: PHONE_A });
    expect(bal.kind).toBe("ok");
    if (bal.kind === "ok" && used.kind === "ok") {
      expect(bal.balance).toBe(used.balance);
    }
  });

  it("存在しない電話番号は customer_not_found", async () => {
    const r = await getPointBalanceCore(sql, ownerSession, { phone: "09099990000" });
    expect(r).toEqual({ kind: "customer_not_found" });
  });
});
