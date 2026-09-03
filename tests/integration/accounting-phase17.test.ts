import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { DEFAULT_BOOKING_FEES } from "@/domain/booking";
import { earnPointsCore, spendPointsCore } from "@/lib/points/queries";
import {
  addExpenseCore,
  getAccountingSummaryCore,
  listExpensesCore,
  postReservationRevenueCore,
  redeemTicketCore,
  reverseTicketEntryCore,
  sellTicketCore,
} from "@/lib/accounting/queries";
import { loadPayoutPolicy } from "@/lib/accounting/policy";

/**
 * フェーズ17 統合テスト（実 Postgres 必須 / migrations 0015 適用済み前提）。
 *
 * 完了条件（受入 L1069）「前受金・ポイント引当・売上・経費が分けて出る」の実証:
 *
 * A. 予約の売上が revenue_lines に**独立行**で立つ（合算しない / spec L856）
 * B. ポイント利用が**マイナスの point_use 行**で立ち、売上と分離される（L847・受入 L1104）
 *    ポイント付与は revenue_lines に現れず、引当（負債）として別集計（L846）
 * C. 二重計上が拒否される（アプリの冪等チェック + **DB の部分 unique** / reviewer B2）
 * D. 回数券: 発行 = 前受金（売上に立たない）→ 消化 = 振替（ticket_redeem 行・端数配分
 *    / 受入 L1092）→ 逆仕訳で残回数と前受金が戻る（受入 L1091）
 * E. 消化予約に course 行が立たない（前受金の振替と現金売上の二重計上を DB が防ぐ）
 * F. 経費が別枠で出て、突合（売上−バック−経費 / spec 11-6）に反映される（受入 L1132）
 * G. getAccountingSummary が売上・支払内訳・ポイント引当・前受金・経費を**別々に**返す
 * H. 追記専用: revenue_lines / payments / ticket_entries の update/delete が
 *    permission denied
 * I. payout_policy 既定 = 「バック基礎に含める」（spec L848）
 *
 * 前提: pnpm db:reset 済み。予約は他テストと衝突しないよう +40日以降に配置。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const OWNER_USER = "aaaaaaaa-0000-4000-8000-000000000001";
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const ownerSession: Session = { userId: OWNER_USER, role: "owner" };
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

const SUFFIX = String(Date.now() + 17).slice(-4);
const PHONE = "0903333" + SUFFIX;

let therapistId: string;
let customerId: string;
let addressId: string;
let areaId: string;
let courseId: string;
let optionId: string;

// +40日以降に配置（他テストの exclusion と衝突しない）
const DAY = 24 * 60 * 60 * 1000;
const baseStart = new Date(Date.now() + 40 * DAY);
// 14:00 JST 開始（深夜加算なし）に丸める
baseStart.setUTCHours(5, 0, 0, 0);

const resIds: string[] = [];

async function insertReservation(params: {
  offsetDays: number;
  status: string;
  nominationFee: number;
  transportFee: number;
  totalAmount: number;
}): Promise<string> {
  const start = new Date(baseStart.getTime() + params.offsetDays * DAY);
  const end = new Date(start.getTime() + 60 * 60_000);
  const depart = new Date(start.getTime() - 20 * 60_000);
  const free = new Date(end.getTime() + 20 * 60_000);
  const rows = await sql<{ id: string }[]>`
    insert into reservations
      (therapist_id, customer_id, address_id, area_id, course_id,
       start_at, end_at, depart_at, free_at,
       travel_in_min, travel_out_min, buffer_min, status,
       nomination_fee, transport_fee, total_amount)
    values
      (${therapistId}::uuid, ${customerId}::uuid, ${addressId}::uuid,
       ${areaId}::uuid, ${courseId}::uuid,
       ${start}, ${end}, ${depart}, ${free},
       20, 20, 0, ${params.status}::reservation_status,
       ${params.nominationFee}, ${params.transportFee}, ${params.totalAmount})
    returning id
  `;
  const id = rows[0]!.id;
  resIds.push(id);
  return id;
}

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`
    select id from therapists where slug = 'aoi' limit 1
  `;
  therapistId = t[0]!.id;

  const c = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE}, 'P17顧客') returning id
  `;
  customerId = c[0]!.id;

  const a = await sql<{ id: string }[]>`select id from areas limit 1`;
  areaId = a[0]!.id;
  const co = await sql<{ id: string }[]>`
    select id from courses where is_active = true limit 1
  `;
  courseId = co[0]!.id;
  const op = await sql<{ id: string }[]>`select id from options limit 1`;
  optionId = op[0]!.id;

  const ad = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id)
    values (${customerId}::uuid, 'home', 'P17テスト住所', ${areaId}::uuid)
    returning id
  `;
  addressId = ad[0]!.id;
});

afterAll(async () => {
  // 追記専用テーブルは superuser（保守経路）で掃除
  if (resIds.length > 0) {
    await sql`delete from payments where reservation_id = any(${resIds}::uuid[])`;
    await sql`delete from revenue_lines where reservation_id = any(${resIds}::uuid[])`;
  }
  await sql`delete from ticket_entries where customer_id = ${customerId}::uuid`;
  await sql`delete from point_entries where customer_id = ${customerId}::uuid`;
  await sql`delete from expenses where note like 'p17-test%'`;
  if (resIds.length > 0) {
    await sql`delete from reservations where id = any(${resIds}::uuid[])`;
  }
  await sql`delete from addresses where id = ${addressId}::uuid`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

// ==========================================================================
// A + B + C: 予約の売上計上（独立行・ポイント連動・冪等）
// ==========================================================================
describe("A+B: 売上が独立行で立ち、ポイント利用がマイナス行で分離（spec L856・L847）", () => {
  let r1: string;

  it("done 予約の計上: course/option/nomination/transport が独立行", async () => {
    // total 15000 = course残差11000 + option2000 + 指名1000 + 交通1000（深夜0）
    r1 = await insertReservation({
      offsetDays: 0,
      status: "done",
      nominationFee: 1000,
      transportFee: 1000,
      totalAmount: 15000,
    });
    await sql`
      insert into reservation_options
        (reservation_id, option_id, price_snapshot, duration_snapshot,
         back_type_snapshot, back_value_snapshot)
      values (${r1}::uuid, ${optionId}::uuid, 2000, 15, 'fixed', 500)
    `;
    // ポイント: 500P 付与 → この予約で 300P 利用（フェーズ16 の台帳経由）
    const earn = await earnPointsCore(sql, ownerSession, {
      customerId,
      points: 500,
      reason: "p17-earn",
    });
    expect(earn.kind).toBe("ok");
    const use = await spendPointsCore(sql, ownerSession, {
      customerId,
      requestedPoints: 300,
      reservationId: r1,
      reason: "p17-use",
    });
    expect(use.kind).toBe("ok");

    const outcome = await postReservationRevenueCore(sql, receptionSession, {
      reservationId: r1,
      fees: DEFAULT_BOOKING_FEES,
      payments: [{ method: "cash", amount: 14700 }],
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.pointsUsed).toBe(300);
    expect(outcome.ticketPaid).toBe(false);

    // DB 上も独立行（合算行が無い）
    const lines = await sql<{ line_type: string; amount: number }[]>`
      select line_type::text as line_type, amount from revenue_lines
      where reservation_id = ${r1}::uuid order by id
    `;
    expect(lines).toEqual([
      { line_type: "course", amount: 11000 },
      { line_type: "option", amount: 2000 },
      { line_type: "nomination", amount: 1000 },
      { line_type: "transport", amount: 1000 },
      { line_type: "point_use", amount: -300 },
    ]);
  });

  it("ポイント付与は revenue_lines に一切現れない（引当 = 負債 / spec L846）", async () => {
    const n = await sql<{ n: number }[]>`
      select count(*)::int as n from revenue_lines
      where line_type not in
        ('course','option','nomination','transport','midnight','discount',
         'point_use','ticket_redeem')
    `;
    expect(n[0]!.n).toBe(0);
    // earn 500 − use 300 = 200 が引当として台帳に残る（売上とは別枠）
    const bal = await sql<{ s: number }[]>`
      select coalesce(sum(points), 0)::integer as s from point_entries
      where customer_id = ${customerId}::uuid
    `;
    expect(bal[0]!.s).toBe(200);
  });

  it("C: 二重計上は already_posted（冪等）", async () => {
    const again = await postReservationRevenueCore(sql, receptionSession, {
      reservationId: r1,
      fees: DEFAULT_BOOKING_FEES,
    });
    expect(again.kind).toBe("already_posted");
  });

  it("C: DB 制約でも防がれる（course 行の直接二重 insert → unique violation）", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`
          insert into revenue_lines
            (reservation_id, line_type, amount, occurred_at, created_by)
          values (${r1}::uuid, 'course', 9999, now(), ${OWNER_USER}::uuid)
        `;
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("確定（confirmed）段階では計上できない（認識時点 = done）", async () => {
    const r2 = await insertReservation({
      offsetDays: 1,
      status: "confirmed",
      nominationFee: 0,
      transportFee: 0,
      totalAmount: 10000,
    });
    const outcome = await postReservationRevenueCore(sql, receptionSession, {
      reservationId: r2,
      fees: DEFAULT_BOOKING_FEES,
    });
    expect(outcome.kind).toBe("not_done");
  });
});

// ==========================================================================
// D + E: 回数券（前受金 → 振替 → 逆仕訳）
// ==========================================================================
describe("D+E: 回数券は前受金、消化で振替、逆仕訳で戻る（spec L857・受入 L1091-1092）", () => {
  let r3: string;
  let redeemEntryId: string;

  it("発行（10,000円3回券）は前受金。売上には立たない", async () => {
    const sell = await sellTicketCore(sql, receptionSession, {
      customerId,
      count: 3,
      totalAmount: 10000,
      reason: "p17-ticket",
    });
    expect(sell.kind).toBe("ok");
    if (sell.kind !== "ok") return;
    expect(sell.remainingCount).toBe(3);
    expect(sell.deferredAmount).toBe(10000);

    // 発行は revenue_lines に現れない
    const n = await sql<{ n: number }[]>`
      select count(*)::int as n from revenue_lines where line_type = 'ticket_redeem'
    `;
    expect(n[0]!.n).toBe(0);
  });

  it("消化: redeem −3,333（端数配分）+ ticket_redeem 行 + 支払内訳 ticket", async () => {
    r3 = await insertReservation({
      offsetDays: 2,
      status: "done",
      nominationFee: 0,
      transportFee: 0,
      totalAmount: 12000,
    });
    const redeem = await redeemTicketCore(sql, receptionSession, {
      customerId,
      reservationId: r3,
    });
    expect(redeem.kind).toBe("ok");
    if (redeem.kind !== "ok") return;
    expect(redeem.redeemAmount).toBe(3333); // 受入 L1092: 1回目は 3,333
    expect(redeem.remainingCount).toBe(2);
    expect(redeem.deferredAmount).toBe(6667); // 前受金が配分額だけ減る

    const entries = await sql<{ id: string; type: string; count: number; amount: number }[]>`
      select id::text as id, type::text as type, count, amount from ticket_entries
      where reservation_id = ${r3}::uuid and type = 'redeem'
    `;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ count: -1, amount: -3333 });
    redeemEntryId = entries[0]!.id;

    const pay = await sql<{ method: string; amount: number }[]>`
      select method::text as method, amount from payments
      where reservation_id = ${r3}::uuid
    `;
    expect(pay).toEqual([{ method: "ticket", amount: 3333 }]);
  });

  it("E: 消化予約の売上計上は course 行を立てない（振替との二重計上防止）", async () => {
    const outcome = await postReservationRevenueCore(sql, receptionSession, {
      reservationId: r3,
      fees: DEFAULT_BOOKING_FEES,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.ticketPaid).toBe(true);
    expect(outcome.lines.every((l) => l.lineType !== "course")).toBe(true);

    // この予約の売上 = 振替 3,333 のみ（定価 12,000 の現金売上と混同しない）
    const lines = await sql<{ line_type: string; amount: number }[]>`
      select line_type::text as line_type, amount from revenue_lines
      where reservation_id = ${r3}::uuid and reversal_of is null
    `;
    expect(lines).toEqual([{ line_type: "ticket_redeem", amount: 3333 }]);
  });

  it("同一予約への二重消化は拒否（already_redeemed / DB unique）", async () => {
    const again = await redeemTicketCore(sql, receptionSession, {
      customerId,
      reservationId: r3,
    });
    expect(again.kind).toBe("already_redeemed");
  });

  it("現金計上済みの予約への消化は拒否（course_already_posted）", async () => {
    const r4 = await insertReservation({
      offsetDays: 3,
      status: "done",
      nominationFee: 0,
      transportFee: 0,
      totalAmount: 10000,
    });
    const posted = await postReservationRevenueCore(sql, receptionSession, {
      reservationId: r4,
      fees: DEFAULT_BOOKING_FEES,
    });
    expect(posted.kind).toBe("ok");
    const redeem = await redeemTicketCore(sql, receptionSession, {
      customerId,
      reservationId: r4,
    });
    expect(redeem.kind).toBe("course_already_posted");
  });

  it("逆仕訳: 残回数と前受金が戻り、振替売上も打ち消される（受入 L1091）", async () => {
    const rev = await reverseTicketEntryCore(sql, ownerSession, {
      entryId: redeemEntryId,
      reason: "p17-reverse",
    });
    expect(rev.kind).toBe("ok");
    if (rev.kind !== "ok") return;
    expect(rev.remainingCount).toBe(3); // 3回に戻る
    expect(rev.deferredAmount).toBe(10000); // 前受金も全額に戻る

    // 振替売上は逆仕訳行（reversal_of つき負行）で純額 0
    const net = await sql<{ s: number }[]>`
      select coalesce(sum(amount), 0)::integer as s from revenue_lines
      where reservation_id = ${r3}::uuid and line_type = 'ticket_redeem'
    `;
    expect(net[0]!.s).toBe(0);
    // 支払内訳も打ち消し済み
    const payNet = await sql<{ s: number }[]>`
      select coalesce(sum(amount), 0)::integer as s from payments
      where reservation_id = ${r3}::uuid
    `;
    expect(payNet[0]!.s).toBe(0);
  });

  it("二重逆仕訳は拒否（already_reversed / DB unique）", async () => {
    const again = await reverseTicketEntryCore(sql, ownerSession, {
      entryId: redeemEntryId,
      reason: "p17-reverse-2",
    });
    expect(again.kind).toBe("already_reversed");
  });
});

// ==========================================================================
// F + G: 経費と基本集計（完了条件 L1069 の実証点）
// ==========================================================================
describe("F+G: 前受金・ポイント引当・売上・経費が分けて出る（受入 L1069・L1132）", () => {
  it("経費を入力して期間で引ける", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const added = await addExpenseCore(sql, receptionSession, {
      category: "oil",
      amount: 3000,
      spentOn: today,
      areaId,
      note: "p17-test-oil",
    });
    expect(added.id).toBeTruthy();
    await addExpenseCore(sql, receptionSession, {
      category: "ads",
      amount: 5000,
      spentOn: today,
      note: "p17-test-ads",
    });

    const from = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    const to = new Date(Date.now() + DAY).toISOString().slice(0, 10);
    const items = await listExpensesCore(sql, receptionSession, {
      fromDate: from,
      toDate: to,
    });
    const mine = items.filter((i) => i.note?.startsWith("p17-test"));
    expect(mine).toHaveLength(2);
  });

  it("getAccountingSummary: 売上・支払内訳・引当・前受金・経費が別々の枠で返る", async () => {
    // 予約群（+40〜+43日）と経費（今日）を両方含む期間
    const from = new Date(Date.now() - DAY);
    const to = new Date(baseStart.getTime() + 10 * DAY);
    const s = await getAccountingSummaryCore(sql, ownerSession, {
      from,
      to,
      therapistId,
    });

    // 売上（revenue_lines のみ / spec L858）: r1 の4行 + point_use − r3 振替は逆仕訳済 0
    // + r4 の course 10000
    expect(s.revenue.byType.course).toBe(11000 + 10000);
    expect(s.revenue.byType.option).toBe(2000);
    expect(s.revenue.byType.nomination).toBe(1000);
    expect(s.revenue.byType.transport).toBe(1000); // 内訳には残す
    expect(s.revenue.byType.point_use).toBe(-300); // マイナスで分離（受入 L1104）
    expect(s.revenue.byType.ticket_redeem).toBe(0); // 逆仕訳で相殺済み
    // ★交通費は売上 total から除外（発注者決定 2026-09-04）。byType には残るが total には入らない
    expect(s.revenue.total).toBe(11000 + 10000 + 2000 + 1000 - 300);

    // 支払方法内訳（現金 + 回数券は逆仕訳で 0）
    expect(s.payments.byMethod.cash).toBe(14700);
    expect(s.payments.byMethod.ticket).toBe(0);

    // ポイント引当（負債・全社）: 内訳の恒等式と、この顧客分（+200）の反映
    expect(s.pointLiability.liability).toBe(
      s.pointLiability.earned -
        s.pointLiability.used -
        s.pointLiability.expired +
        s.pointLiability.adjusted,
    );
    expect(s.pointLiability.liability).toBeGreaterThanOrEqual(200);

    // 前受金（回数券残）: 逆仕訳後は全額 10,000（3回）
    expect(s.deferredRevenue).toEqual({ remainingCount: 3, deferredAmount: 10000 });

    // 経費（受入 L1132: 突合に反映される）
    expect(s.expenses.byCategory.oil).toBeGreaterThanOrEqual(3000);
    expect(s.expenses.byCategory.ads).toBeGreaterThanOrEqual(5000);

    // 突合（spec 11-6）: 粗利 = 売上 − バック(フェーズ18まで0) − 経費
    expect(s.settlement.payout).toBe(0);
    expect(s.settlement.grossProfit).toBe(s.revenue.total - s.expenses.total);
  });

  it("エリア絞り込みで経費・売上が絞れる（期間 × エリア / spec L860）", async () => {
    const from = new Date(Date.now() - DAY);
    const to = new Date(baseStart.getTime() + 10 * DAY);
    const s = await getAccountingSummaryCore(sql, ownerSession, {
      from,
      to,
      areaId,
      therapistId,
    });
    // ads 経費はエリアなしで入れたため、エリア絞り込みでは落ちる
    expect(s.expenses.byCategory.ads).toBe(0);
    expect(s.expenses.byCategory.oil).toBeGreaterThanOrEqual(3000);
  });
});

// ==========================================================================
// H: 追記専用（update/delete が permission denied）
// ==========================================================================
describe("H: 台帳は追記専用（update/delete が拒否される）", () => {
  it("revenue_lines の update が permission denied", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`update revenue_lines set amount = 1 where amount = 11000`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("revenue_lines の delete が permission denied", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`delete from revenue_lines where amount = 11000`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("ticket_entries の update/delete が permission denied", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`update ticket_entries set amount = 0 where customer_id = ${customerId}::uuid`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`delete from ticket_entries where customer_id = ${customerId}::uuid`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("payments の update が permission denied", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`update payments set amount = 1 where method = 'cash'`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("符号規約: 正の point_use 行は check violation（値引は必ず負）", async () => {
    const firstResId = resIds[0];
    expect(firstResId).toBeTruthy();
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`
          insert into revenue_lines
            (reservation_id, line_type, amount, occurred_at, created_by)
          values (${firstResId ?? ""}::uuid, 'discount', 100, now(), ${OWNER_USER}::uuid)
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// ==========================================================================
// I: payout_policy（spec L848 既定 = 含める。フェーズ18 が読む）
// ==========================================================================
describe("I: バック計算基礎の設定フラグ（spec L848・L917）", () => {
  it("既定はポイント利用分・回数券消化ともに基礎へ「含める」", async () => {
    const policy = await loadPayoutPolicy(sql);
    expect(policy).toEqual({
      includePointUseInBase: true,
      includeTicketRedeemInBase: true,
    });
  });
});
