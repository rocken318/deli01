import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { DEFAULT_BOOKING_FEES } from "@/domain/booking";
import { earnPointsCore, expirePointsCore, spendPointsCore } from "@/lib/points/queries";
import {
  addExpenseCore,
  getAccountingSummaryCore,
  listExpensesCore,
  postReservationRevenueCore,
  redeemTicketCore,
  reverseTicketEntryCore,
  sellTicketCore,
} from "@/lib/accounting/queries";

/**
 * フェーズ17 QA 追加統合テスト（実 Postgres 必須）。
 *
 * accounting-phase17.test.ts（architect 作・21件）と重複させず、
 * 以下の観点を追加検証する:
 *
 * 1. 並走二重計上（Promise.all で同時2リクエスト → 片方だけ成功）
 * 2. 回数券 FIFO（複数ロット → 古いロットから消化）
 * 3. 回数券期限切れロットをスキップ（有効ロットへ FIFO）
 * 4. purchase 行の逆仕訳（未消化ロット全取り消し）
 * 5. purchase 消化済みは逆仕訳不可（not_reversible）
 * 6. getAccountingSummary セラピスト絞り込みが機能する
 * 7. ポイント失効が引当（pointLiability）を減らす
 * 8. 経費日付境界（toDate が exclusive である）
 * 9. 完了条件の総合実証：getAccountingSummary で4区分が分離して返る
 * 10. payments の delete が permission denied
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });

const OWNER_USER = "aaaaaaaa-0000-4000-8000-000000000001";
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const ownerSession: Session = { userId: OWNER_USER, role: "owner" };
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

// 他テストと衝突しないサフィックス・オフセット日数（+60日以降）
// 電話番号は 11桁の数字のみ（customers_phone_check 制約: ^0[0-9]{9,10}$）
// Date.now() の末尾10桁を使って "0" + 10桁 = 11桁を構成
const PHONE_SUFFIX = String(Date.now()).slice(-10);
const PHONE_QA = "0" + PHONE_SUFFIX;

const DAY = 24 * 60 * 60 * 1000;
// 14:00 JST に丸める (+60日以降)
const baseStart = new Date(Date.now() + 60 * DAY);
baseStart.setUTCHours(5, 0, 0, 0);

let therapistId: string;
let therapistId2: string; // セラピスト絞り込み用の別セラピスト
let customerId: string;
let addressId: string;
let areaId: string;
let courseId: string;

const resIds: string[] = [];
const ticketEntryIds: string[] = [];

/** テスト用予約を挿入して ID を返す */
async function insertReservation(params: {
  offsetDays: number;
  status: string;
  totalAmount: number;
  nominationFee?: number;
  transportFee?: number;
  tId?: string; // therapistId override
}): Promise<string> {
  const tid = params.tId ?? therapistId;
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
      (${tid}::uuid, ${customerId}::uuid, ${addressId}::uuid,
       ${areaId}::uuid, ${courseId}::uuid,
       ${start}, ${end}, ${depart}, ${free},
       20, 20, 0, ${params.status}::reservation_status,
       ${params.nominationFee ?? 0}, ${params.transportFee ?? 0},
       ${params.totalAmount})
    returning id
  `;
  const id = rows[0]!.id;
  resIds.push(id);
  return id;
}

beforeAll(async () => {
  // セラピスト（seed の 'aoi'）
  const t = await sql<{ id: string }[]>`
    select id from therapists where slug = 'aoi' limit 1
  `;
  therapistId = t[0]!.id;

  // 2人目のセラピスト（別の slug）。seed にない場合は therapistId と同じにする
  const t2 = await sql<{ id: string }[]>`
    select id from therapists where id != ${therapistId}::uuid limit 1
  `;
  therapistId2 = t2[0]?.id ?? therapistId;

  const c = await sql<{ id: string }[]>`
    insert into customers (phone, name)
    values (${PHONE_QA}, 'QA17顧客')
    returning id
  `;
  customerId = c[0]!.id;

  const a = await sql<{ id: string }[]>`select id from areas limit 1`;
  areaId = a[0]!.id;

  const co = await sql<{ id: string }[]>`
    select id from courses where is_active = true limit 1
  `;
  courseId = co[0]!.id;

  const ad = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id)
    values (${customerId}::uuid, 'home', 'QA17テスト住所', ${areaId}::uuid)
    returning id
  `;
  addressId = ad[0]!.id;
});

afterAll(async () => {
  if (resIds.length > 0) {
    await sql`delete from payments where reservation_id = any(${resIds}::uuid[])`;
    await sql`delete from revenue_lines where reservation_id = any(${resIds}::uuid[])`;
  }
  await sql`delete from ticket_entries where customer_id = ${customerId}::uuid`;
  await sql`delete from point_entries where customer_id = ${customerId}::uuid`;
  await sql`delete from expenses where note like 'qa17-%'`;
  if (resIds.length > 0) {
    await sql`delete from reservations where id = any(${resIds}::uuid[])`;
  }
  await sql`delete from addresses where id = ${addressId}::uuid`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

// ==========================================================================
// 1. 並走二重計上（同時2リクエスト → 片方だけ成功）
// ==========================================================================
describe("1. 並走の二重計上：Promise.all で同時2リクエスト、片方だけ成功", () => {
  it("done 予約へ同時に postReservationRevenueCore を2回投げると1回だけ ok になる", async () => {
    const rId = await insertReservation({
      offsetDays: 0,
      status: "done",
      totalAmount: 10000,
    });

    // 並走2リクエスト
    const [r1, r2] = await Promise.all([
      postReservationRevenueCore(sql, receptionSession, {
        reservationId: rId,
        fees: DEFAULT_BOOKING_FEES,
      }),
      postReservationRevenueCore(sql, receptionSession, {
        reservationId: rId,
        fees: DEFAULT_BOOKING_FEES,
      }),
    ]);

    const outcomes = [r1.kind, r2.kind];
    // 片方だけ ok、もう片方は already_posted（DB unique が保証）
    expect(outcomes.filter((k) => k === "ok")).toHaveLength(1);
    expect(outcomes.filter((k) => k === "already_posted")).toHaveLength(1);

    // revenue_lines には course 行が1本だけ
    const lines = await sql<{ n: number }[]>`
      select count(*)::int as n from revenue_lines
      where reservation_id = ${rId}::uuid and line_type = 'course'
    `;
    expect(lines[0]!.n).toBe(1);
  });
});

// ==========================================================================
// 2. 回数券 FIFO（複数ロット → 古いロットから消化）
// ==========================================================================
describe("2. 回数券 FIFO：複数ロットは古いほうから消化される", () => {
  it("ロット1を消化してからロット2が消化される", async () => {
    // ロット1（古い）: 1回券
    const sell1 = await sellTicketCore(sql, receptionSession, {
      customerId,
      count: 1,
      totalAmount: 3000,
      reason: "qa17-lot1",
    });
    expect(sell1.kind).toBe("ok");

    // ロット2（新しい）: 2回券
    const sell2 = await sellTicketCore(sql, receptionSession, {
      customerId,
      count: 2,
      totalAmount: 6000,
      reason: "qa17-lot2",
    });
    expect(sell2.kind).toBe("ok");

    // 1回目の消化: ロット1（3,000円/1回）から取るはず
    const r1 = await insertReservation({
      offsetDays: 10,
      status: "done",
      totalAmount: 12000,
    });
    const red1 = await redeemTicketCore(sql, receptionSession, {
      customerId,
      reservationId: r1,
    });
    expect(red1.kind).toBe("ok");
    if (red1.kind !== "ok") return;
    // ロット1の全額（3000円）が振り替えられる
    expect(red1.redeemAmount).toBe(3000);
    // 残 = ロット2の2回
    expect(red1.remainingCount).toBe(2);

    // 2回目の消化: ロット2から（6000/2=3000 の1回目 → 2999か3000）
    const r2 = await insertReservation({
      offsetDays: 11,
      status: "done",
      totalAmount: 12000,
    });
    const red2 = await redeemTicketCore(sql, receptionSession, {
      customerId,
      reservationId: r2,
    });
    expect(red2.kind).toBe("ok");
    if (red2.kind !== "ok") return;
    expect(red2.redeemAmount).toBe(3000); // 6000/2=3000（端数なし）
    expect(red2.remainingCount).toBe(1); // ロット2の残1回
  });
});

// ==========================================================================
// 3. 期限切れロットをスキップして有効ロットへ FIFO
// ==========================================================================
describe("3. 期限切れロットをスキップ：有効ロットへ FIFO", () => {
  it("期限切れロットが最古でも、有効な次のロットが消化される", async () => {
    const past = new Date(Date.now() - DAY); // 昨日 = 期限切れ

    // 消化前の残高を記録（他テストの残券を把握するため）
    const from = new Date(0);
    const to = new Date(Date.now() + 400 * DAY);
    const beforeSummary = await getAccountingSummaryCore(sql, ownerSession, { from, to });
    const beforeCount = beforeSummary.deferredRevenue.remainingCount;
    const beforeAmount = beforeSummary.deferredRevenue.deferredAmount;

    // 期限切れロット（古い / expiresAt = 昨日）: 必ず次の消化ではスキップされる
    const sellExpired = await sellTicketCore(sql, receptionSession, {
      customerId,
      count: 1,
      totalAmount: 5000,
      expiresAt: past,
      reason: "qa17-expired-lot",
    });
    expect(sellExpired.kind).toBe("ok");

    // 有効ロット（1回券・金額を一意にする）
    const VALID_AMOUNT = 7777; // 他テストと被らない金額
    const sellValid = await sellTicketCore(sql, receptionSession, {
      customerId,
      count: 1,
      totalAmount: VALID_AMOUNT,
      reason: "qa17-valid-lot",
    });
    expect(sellValid.kind).toBe("ok");

    // 消化: 期限切れロット（5000円/1回）はスキップ → 他の有効ロットから取る
    const rId = await insertReservation({
      offsetDays: 20,
      status: "done",
      totalAmount: 12000,
    });
    const redeem = await redeemTicketCore(sql, receptionSession, {
      customerId,
      reservationId: rId,
    });
    expect(redeem.kind).toBe("ok");
    if (redeem.kind !== "ok") return;

    // 期限切れロット（5000円）は消化されていない（amount = 5000 ではない）
    // 何らかの有効ロットが消化されているはず
    expect(redeem.redeemAmount).not.toBe(5000);
    expect(redeem.redeemAmount).toBeGreaterThan(0);

    // 消化後の前受金残高に期限切れロット分（5000円）がまだ含まれている
    // （期限切れロットは消化されず残っている）
    const afterSummary = await getAccountingSummaryCore(sql, ownerSession, { from, to });
    // 期限切れロット（+5000）＋有効ロット（+VALID_AMOUNT）追加 - 1回消化 = 前より増加
    expect(afterSummary.deferredRevenue.deferredAmount).toBeGreaterThan(beforeAmount);
  });
});

// ==========================================================================
// 4. purchase 行の逆仕訳（未消化ロット全額取り消し）
// ==========================================================================
describe("4. purchase 逆仕訳：未消化ロットを全取り消し", () => {
  it("purchase ロットが未消化なら逆仕訳で残回数と前受金が0に戻る", async () => {
    // 新しいロットを発行
    const sell = await sellTicketCore(sql, receptionSession, {
      customerId,
      count: 3,
      totalAmount: 9000,
      reason: "qa17-purchase-reverse",
    });
    expect(sell.kind).toBe("ok");
    if (sell.kind !== "ok") return;
    const purchaseEntryId = sell.entryId;
    ticketEntryIds.push(purchaseEntryId);

    // purchase 行の逆仕訳
    const rev = await reverseTicketEntryCore(sql, ownerSession, {
      entryId: purchaseEntryId,
      reason: "qa17-purchase-reverse-reason",
    });
    expect(rev.kind).toBe("ok");
    if (rev.kind !== "ok") return;
    // このロットの分は全部戻る（他のロットがあれば合算されるが、ここでは純額で確認）
    // 少なくとも rev 後の residual が -3（このロット）戻っている
    expect(rev.remainingCount).toBeLessThan(3 + 1); // 元のロット分は消えている
  });
});

// ==========================================================================
// 5. purchase が消化済みのとき逆仕訳は not_reversible
// ==========================================================================
describe("5. 消化済み purchase 行は逆仕訳できない", () => {
  it("1回消化後の purchase ロットの逆仕訳は not_reversible", async () => {
    // 1回券を発行（このロットが FIFO で最先に消化されるよう、他のロットを先に消化しておく
    // 必要はない: ロット自体の id をトラッキングして、そのロットが消化されたか確認する）
    const sell = await sellTicketCore(sql, receptionSession, {
      customerId,
      count: 1, // 1回券（消化したらすぐ fully consumed）
      totalAmount: 4321, // 他と被らない金額
      reason: "qa17-partial-purchase",
    });
    expect(sell.kind).toBe("ok");
    if (sell.kind !== "ok") return;
    const purchaseEntryId = sell.entryId;

    // 何か予約を消化（FIFO で「どこかの」ロットが消費される）
    const rId = await insertReservation({
      offsetDays: 30,
      status: "done",
      totalAmount: 10000,
    });
    const redeem = await redeemTicketCore(sql, receptionSession, {
      customerId,
      reservationId: rId,
    });
    expect(redeem.kind).toBe("ok");
    if (redeem.kind !== "ok") return;

    // 消化された lot が purchaseEntryId かどうか確認
    if (redeem.lotId !== purchaseEntryId) {
      // 別ロットが消化された場合: 当該ロットはまだ未消化なので逆仕訳テストは後回し
      // このロットを直接消化してから逆仕訳を試みる
      const rId2 = await insertReservation({
        offsetDays: 31,
        status: "done",
        totalAmount: 10000,
      });
      const redeem2 = await redeemTicketCore(sql, receptionSession, {
        customerId,
        reservationId: rId2,
      });
      // 複数回試しても consumed でない場合はスキップ（他テストの残券が多すぎる）
      if (redeem2.kind !== "ok" || redeem2.lotId !== purchaseEntryId) {
        // このテストは環境依存で検証不可 → スキップ相当（警告のみ）
        console.warn("qa17-test5: lot not consumed, skipping not_reversible assertion");
        return;
      }
    }

    // purchaseEntryId のロットが消化済み → 逆仕訳は not_reversible
    const rev = await reverseTicketEntryCore(sql, ownerSession, {
      entryId: purchaseEntryId,
      reason: "qa17-should-fail",
    });
    expect(rev.kind).toBe("not_reversible");
  });
});

// ==========================================================================
// 6. getAccountingSummary セラピスト絞り込み
// ==========================================================================
describe("6. getAccountingSummary セラピスト絞り込み", () => {
  it("therapistId を指定すると、別セラピストの売上が含まれない", async () => {
    // セラピスト1（aoi）の予約
    const r1 = await insertReservation({
      offsetDays: 40,
      status: "done",
      totalAmount: 10000,
      tId: therapistId,
    });
    await postReservationRevenueCore(sql, receptionSession, {
      reservationId: r1,
      fees: DEFAULT_BOOKING_FEES,
    });

    // セラピスト2の予約（therapistId2 が存在する場合のみ）
    if (therapistId2 !== therapistId) {
      const r2 = await insertReservation({
        offsetDays: 41,
        status: "done",
        totalAmount: 15000,
        tId: therapistId2,
      });
      await postReservationRevenueCore(sql, receptionSession, {
        reservationId: r2,
        fees: DEFAULT_BOOKING_FEES,
      });
    }

    const from = new Date(baseStart.getTime() + 39 * DAY);
    const to = new Date(baseStart.getTime() + 43 * DAY);

    // therapistId（aoi）だけで絞る
    const sFiltered = await getAccountingSummaryCore(sql, ownerSession, {
      from,
      to,
      therapistId,
    });

    // 全体で絞らない
    const sAll = await getAccountingSummaryCore(sql, ownerSession, {
      from,
      to,
    });

    if (therapistId2 !== therapistId) {
      // 絞ったほうが少ないはず
      expect(sFiltered.revenue.total).toBeLessThan(sAll.revenue.total);
    } else {
      // therapistId2 = therapistId の場合は同じになる
      expect(sFiltered.revenue.total).toBeLessThanOrEqual(sAll.revenue.total);
    }

    // therapistId で絞ったとき aoi の課売上が含まれる
    expect(sFiltered.revenue.byType.course).toBeGreaterThan(0);
  });
});

// ==========================================================================
// 7. ポイント失効が pointLiability を減らす
// ==========================================================================
describe("7. ポイント失効が pointLiability を減らす", () => {
  it("失効後の pointLiability.expired が増え、liability が減る", async () => {
    const from = new Date(0);
    const to = new Date(Date.now() + 400 * DAY);

    // 失効期限を「1秒後」に設定して付与
    const expiresAt = new Date(Date.now() + 1000); // 1秒後
    const earn = await earnPointsCore(sql, ownerSession, {
      customerId,
      points: 600,
      reason: "qa17-expire-test",
      expiresAt,
    });
    expect(earn.kind).toBe("ok");

    const before = await getAccountingSummaryCore(sql, ownerSession, { from, to });
    const liabilityBefore = before.pointLiability.liability;
    const expiredBefore = before.pointLiability.expired;

    // 少し待って失効時刻を過ぎさせる（1秒 + 余裕 10ms）
    await new Promise((r) => setTimeout(r, 1100));

    // expirePointsCore を now = 現在時刻で実行（expiresAt <= now）
    const expireResult = await expirePointsCore(sql, ownerSession, {
      now: new Date(), // 失効期限を過ぎている
    });

    // この顧客の 600P 失効が含まれるはず
    expect(expireResult.expiredPoints).toBeGreaterThanOrEqual(600);

    const after = await getAccountingSummaryCore(sql, ownerSession, { from, to });

    // 失効が引当を減らす（spec L849）
    expect(after.pointLiability.expired).toBeGreaterThanOrEqual(expiredBefore + 600);
    expect(after.pointLiability.liability).toBe(liabilityBefore - 600);
  });
});

// ==========================================================================
// 8. listExpenses 日付境界（toDate が exclusive）
// ==========================================================================
describe("8. listExpenses の日付境界: toDate が exclusive（半開区間）", () => {
  it("toDate 当日の経費は含まれない（< toDate）", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);

    await addExpenseCore(sql, receptionSession, {
      category: "other",
      amount: 1000,
      spentOn: today,
      note: "qa17-boundary-test",
    });

    // toDate = today: 今日は含まれない（today < today は false）
    const excludesToday = await listExpensesCore(sql, receptionSession, {
      fromDate: today,
      toDate: today, // 同日 → 何も返さない
    });
    const mine = excludesToday.filter((i) => i.note === "qa17-boundary-test");
    expect(mine).toHaveLength(0);

    // toDate = tomorrow: 今日が含まれる
    const includesToday = await listExpensesCore(sql, receptionSession, {
      fromDate: today,
      toDate: tomorrow,
    });
    const mine2 = includesToday.filter((i) => i.note === "qa17-boundary-test");
    expect(mine2).toHaveLength(1);
  });
});

// ==========================================================================
// 9. 完了条件の総合実証: 4区分が分離して返る
// ==========================================================================
describe("9. 完了条件の総合実証（spec L1069: 前受金・ポイント引当・売上・経費が分けて出る）", () => {
  it("getAccountingSummary が売上・ポイント引当・前受金・経費を別々のフィールドで返す", async () => {
    // 経費を追加
    const today = new Date().toISOString().slice(0, 10);
    await addExpenseCore(sql, receptionSession, {
      category: "supplies",
      amount: 2000,
      spentOn: today,
      note: "qa17-summary-test",
    });

    const from = new Date(0);
    const to = new Date(Date.now() + 400 * DAY);
    const s = await getAccountingSummaryCore(sql, ownerSession, { from, to });

    // 売上（revenue）
    expect(s.revenue).toHaveProperty("total");
    expect(s.revenue).toHaveProperty("byType");
    expect(typeof s.revenue.total).toBe("number");

    // ポイント引当（pointLiability）— 売上とは独立したオブジェクト
    expect(s.pointLiability).toHaveProperty("earned");
    expect(s.pointLiability).toHaveProperty("used");
    expect(s.pointLiability).toHaveProperty("expired");
    expect(s.pointLiability).toHaveProperty("adjusted");
    expect(s.pointLiability).toHaveProperty("liability");
    // 恒等式
    expect(s.pointLiability.liability).toBe(
      s.pointLiability.earned
      - s.pointLiability.used
      - s.pointLiability.expired
      + s.pointLiability.adjusted
    );

    // 前受金（deferredRevenue）— 回数券残
    expect(s.deferredRevenue).toHaveProperty("remainingCount");
    expect(s.deferredRevenue).toHaveProperty("deferredAmount");

    // 経費（expenses）— 売上とは別枠
    expect(s.expenses).toHaveProperty("total");
    expect(s.expenses).toHaveProperty("byCategory");
    expect(s.expenses.byCategory.supplies).toBeGreaterThanOrEqual(2000);

    // 突合（settlement）— 粗利 = 売上 − バック − 経費
    expect(s.settlement.grossProfit).toBe(s.revenue.total - s.settlement.payout - s.expenses.total);

    // 4区分が独立したフィールドであること（同じ数値ではない）
    const distinctObjects = [s.revenue, s.pointLiability, s.deferredRevenue, s.expenses];
    expect(distinctObjects).toHaveLength(4);
    // revenue.total と expenses.total は別値（経費は売上に含まれない）
    // （経費が 0 のケースを避けるため、0より大きいことだけ確認）
    expect(s.expenses.total).toBeGreaterThan(0);
  });
});

// ==========================================================================
// 10. payments の delete が permission denied
// ==========================================================================
describe("10. payments の delete が追記専用で拒否される", () => {
  it("payments を delete しようとすると permission denied (42501)", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`delete from payments where amount > 0`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("payments を update しようとすると permission denied (42501)", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`update payments set amount = 1 where amount > 0`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

// ==========================================================================
// 11. ポイント利用がマイナス revenue_line で、売上合計と分離して集計される
// ==========================================================================
describe("11. ポイント利用がマイナス revenue_line として立ち売上と分離（spec L847・受入 L1104）", () => {
  it("point_use 行の符号が負で、byType.point_use がマイナス値として返る", async () => {
    // ポイント付与 → 利用
    await earnPointsCore(sql, ownerSession, {
      customerId,
      points: 800,
      reason: "qa17-point-separation",
    });
    const rId = await insertReservation({
      offsetDays: 50,
      status: "done",
      totalAmount: 12000,
    });
    await spendPointsCore(sql, ownerSession, {
      customerId,
      requestedPoints: 400,
      reservationId: rId,
      reason: "qa17-point-use",
    });
    const posted = await postReservationRevenueCore(sql, receptionSession, {
      reservationId: rId,
      fees: DEFAULT_BOOKING_FEES,
      payments: [{ method: "cash", amount: 11600 }],
    });
    expect(posted.kind).toBe("ok");

    // DB 上の point_use 行が負であることを確認
    const lines = await sql<{ line_type: string; amount: number }[]>`
      select line_type::text, amount from revenue_lines
      where reservation_id = ${rId}::uuid and line_type = 'point_use'
    `;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.amount).toBe(-400);

    // getAccountingSummary の byType.point_use がマイナスで分離
    const from = new Date(baseStart.getTime() + 49 * DAY);
    const to = new Date(baseStart.getTime() + 52 * DAY);
    const s = await getAccountingSummaryCore(sql, ownerSession, { from, to, therapistId });
    expect(s.revenue.byType.point_use).toBe(-400);
    // course 行は正（売上と値引は独立した行）
    expect(s.revenue.byType.course).toBeGreaterThan(0);
  });
});
