import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { DEFAULT_BOOKING_FEES } from "@/domain/booking";
import { DEFAULT_PAYOUT_SETTINGS } from "@/domain/payout";
import { redeemTicketCore, sellTicketCore } from "@/lib/accounting/queries";
import { loadPayoutSettings } from "@/lib/payout/policy";
import {
  closePayoutPeriodCore,
  getMyEarningsCore,
  getPayoutRatesGridCore,
  markPayoutPaidCore,
  postReservationPayoutCore,
  reversePayoutLineCore,
  upsertPayoutRateCore,
} from "@/lib/payout/queries";

/**
 * フェーズ18 統合テスト（実 Postgres 必須 / migrations 0016 適用済み前提）。
 * 完了条件 = 15章の報酬テスト:
 *
 * A. (受入 L1096) 個別レート > ランク別 > 既定 の優先順位が正しい
 * B. (受入 L1098) calc_note に計算根拠（レートID・元金額・計算式・適用日）が残る
 * C. (受入 L1095) 回数券を消化した施術でもバックが発生する
 * D. (spec L919) noshow は交通費のみ
 * E. (受入 L1097) 締めたあとの支払がロックされ、修正が逆仕訳になる
 * F. (受入 L1094) レート改定後も、過去に確定した報酬が変わらない
 * G. (受入 L1134) セラピストが他人の報酬を取得できない（RLS）
 * H. 追記専用: payout_lines の update/delete が permission denied (42501)
 * I. 締め期間の重複が exclusion 制約で拒否される
 *
 * 前提: pnpm db:reset 済み。専用のセラピスト2名をこのテストが作る
 * （他テストの exclusion / 締めロックと干渉しないため）。予約は +45日以降。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const OWNER_USER = "aaaaaaaa-0000-4000-8000-000000000001";
const ownerSession: Session = { userId: OWNER_USER, role: "owner" };

// このテスト専用のランクを beforeAll で作成する（seed が 0016 の共有ランク
// 新人/レギュラー/プレミアにデモ用レートを積むため、共有ランクを使うと干渉する）。
let RANK_REGULAR = "";
let RANK_PREMIER = "";

const SUFFIX = String(Date.now() + 18).slice(-6);
const PHONE = "0904" + SUFFIX;

let therapistA: string; // プレミア + 個別レートあり（spec 18-5 あおい相当）
let therapistB: string; // レギュラー（ランク既定のみ）
let userA: string;
let userB: string;
let sessionA: Session;
let sessionB: Session;
let customerId: string;
let addressId: string;
let areaId: string;
let courseId: string;
let optionId: string;

const DAY = 24 * 60 * 60 * 1000;
// +45日・05:00 UTC = 14:00 JST（深夜加算なし・business_date = UTC 日付）
const baseStart = new Date(Date.now() + 45 * DAY);
baseStart.setUTCHours(5, 0, 0, 0);

function jstDate(offsetDays: number): string {
  return new Date(baseStart.getTime() + offsetDays * DAY).toISOString().slice(0, 10);
}

async function insertReservation(params: {
  therapistId: string;
  offsetDays: number;
  status: string;
  nominationFee?: number;
  transportFee?: number;
  totalAmount: number;
  withOption?: boolean;
  startHourUTC?: number;
}): Promise<string> {
  const start = new Date(baseStart.getTime() + params.offsetDays * DAY);
  if (params.startHourUTC !== undefined) {
    start.setUTCHours(params.startHourUTC, 0, 0, 0);
  }
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
      (${params.therapistId}::uuid, ${customerId}::uuid, ${addressId}::uuid,
       ${areaId}::uuid, ${courseId}::uuid,
       ${start}, ${end}, ${depart}, ${free},
       20, 20, 0, ${params.status}::reservation_status,
       ${params.nominationFee ?? 0}, ${params.transportFee ?? 0}, ${params.totalAmount})
    returning id
  `;
  const id = rows[0]!.id;
  if (params.withOption) {
    await sql`
      insert into reservation_options
        (reservation_id, option_id, price_snapshot, duration_snapshot,
         back_type_snapshot, back_value_snapshot)
      values (${id}::uuid, ${optionId}::uuid, 2500, 15, 'rate', 50)
    `;
  }
  return id;
}

async function postPayout(reservationId: string, session: Session = ownerSession) {
  return postReservationPayoutCore(sql, session, {
    reservationId,
    fees: DEFAULT_BOOKING_FEES,
    settings: DEFAULT_PAYOUT_SETTINGS,
  });
}

beforeAll(async () => {
  // このテスト専用のランク（一意名）。seed のデモレートと干渉させない
  const rkP = await sql<{ id: string }[]>`
    insert into therapist_ranks (name, sort_order)
    values (${"p18-premier-" + SUFFIX}, 900) returning id
  `;
  RANK_PREMIER = rkP[0]!.id;
  const rkR = await sql<{ id: string }[]>`
    insert into therapist_ranks (name, sort_order)
    values (${"p18-regular-" + SUFFIX}, 901) returning id
  `;
  RANK_REGULAR = rkR[0]!.id;

  // 専用セラピスト2名（+ therapist ロールの app_users）
  const tA = await sql<{ id: string }[]>`
    insert into therapists (slug, status, rank_id)
    values (${"p18a-" + SUFFIX}, 'active', ${RANK_PREMIER}::uuid)
    returning id
  `;
  therapistA = tA[0]!.id;
  const tB = await sql<{ id: string }[]>`
    insert into therapists (slug, status, rank_id)
    values (${"p18b-" + SUFFIX}, 'active', ${RANK_REGULAR}::uuid)
    returning id
  `;
  therapistB = tB[0]!.id;

  const uA = await sql<{ id: string }[]>`
    insert into app_users (role, display_name, therapist_id)
    values ('therapist', 'P18-A', ${therapistA}::uuid)
    returning id
  `;
  userA = uA[0]!.id;
  const uB = await sql<{ id: string }[]>`
    insert into app_users (role, display_name, therapist_id)
    values ('therapist', 'P18-B', ${therapistB}::uuid)
    returning id
  `;
  userB = uB[0]!.id;
  sessionA = { userId: userA, role: "therapist", therapistId: therapistA };
  sessionB = { userId: userB, role: "therapist", therapistId: therapistB };

  const c = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE}, 'P18顧客') returning id
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
    values (${customerId}::uuid, 'home', 'P18テスト住所', ${areaId}::uuid)
    returning id
  `;
  addressId = ad[0]!.id;

  // レート一式（spec 18-4 相当の既定 + ランク別 + 個別。effective 2026-01-01）
  const mk = (p: {
    therapistId?: string;
    rankId?: string;
    targetType:
      | "course"
      | "option"
      | "nomination"
      | "transport"
      | "late_night"
      | "cancel_fee";
    calcType: "fixed" | "rate";
    value: number;
  }) =>
    upsertPayoutRateCore(sql, ownerSession, {
      therapistId: p.therapistId ?? null,
      rankId: p.rankId ?? null,
      targetType: p.targetType,
      targetId: null,
      calcType: p.calcType,
      value: p.value,
      effectiveFrom: "2026-01-01",
    });
  // 既定
  await mk({ targetType: "course", calcType: "rate", value: 50 });
  await mk({ targetType: "option", calcType: "rate", value: 50 });
  await mk({ targetType: "nomination", calcType: "rate", value: 100 });
  await mk({ targetType: "transport", calcType: "rate", value: 100 });
  await mk({ targetType: "late_night", calcType: "rate", value: 50 });
  await mk({ targetType: "cancel_fee", calcType: "rate", value: 50 });
  // ランク別（レギュラー 55% / プレミア 60%）
  await mk({ rankId: RANK_REGULAR, targetType: "course", calcType: "rate", value: 55 });
  await mk({ rankId: RANK_PREMIER, targetType: "course", calcType: "rate", value: 60 });
  // 個別（A のみ 65% / spec 18-5 あおい相当）
  await mk({ therapistId: therapistA, targetType: "course", calcType: "rate", value: 65 });
});

/** describe C（回数券）の後片付け用（他テストの全社集計を汚さない） */
let ticketReservationId: string | null = null;

afterAll(async () => {
  // 回数券の痕跡を消す（accounting-phase17 は revenue_lines の ticket_redeem 行数と
  // 前受金残を**全社**で数えるため、逆仕訳では行数が残ってしまう）。
  // テスト接続は superuser なので保守経路として物理削除できる
  // （業務経路 app_runtime では revoke 済み = 本番からは不可能な操作）。
  if (ticketReservationId) {
    await sql`delete from payments where reservation_id = ${ticketReservationId}::uuid`;
    await sql`
      delete from revenue_lines
      where reservation_id = ${ticketReservationId}::uuid
        and line_type = 'ticket_redeem'
    `;
  }
  await sql`delete from ticket_entries where customer_id = ${customerId}::uuid`;
  await sql.end();
});

describe("A. レート優先順位（受入 L1096: 個別 > ランク別 > 既定）", () => {
  it("個別レートを持つ A は 65%、ランクのみの B は 55% で計上される", async () => {
    // A: 17000(コース) + 2500(オプション) + 1000(指名) + 1000(交通) = 21500
    const resA = await insertReservation({
      therapistId: therapistA,
      offsetDays: 0,
      status: "done",
      nominationFee: 1000,
      transportFee: 1000,
      totalAmount: 21500,
      withOption: true,
    });
    const outA = await postPayout(resA);
    expect(outA.kind).toBe("ok");
    if (outA.kind !== "ok") return;
    expect(outA.unresolved).toEqual([]);
    const byCat = Object.fromEntries(outA.lines.map((l) => [l.category, l.amount]));
    expect(byCat["course"]).toBe(11050); // 17000×65%（個別）
    expect(byCat["option"]).toBe(1250); // 2500×50%（既定）
    expect(byCat["nomination"]).toBe(1000); // 100%
    expect(byCat["transport"]).toBe(1000); // 100%
    const courseLine = outA.lines.find((l) => l.category === "course");
    expect(courseLine?.calcNote.scope).toBe("individual");

    // B: コースのみ 17000
    const resB = await insertReservation({
      therapistId: therapistB,
      offsetDays: 0,
      status: "done",
      totalAmount: 17000,
    });
    const outB = await postPayout(resB);
    expect(outB.kind).toBe("ok");
    if (outB.kind !== "ok") return;
    const course = outB.lines.find((l) => l.category === "course");
    expect(course?.amount).toBe(9350); // 17000×55%（ランク別）
    expect(course?.calcNote.scope).toBe("rank");
  });

  it("二重計上は拒否される（冪等 + DB unique）", async () => {
    const res = await insertReservation({
      therapistId: therapistB,
      offsetDays: 1,
      status: "done",
      totalAmount: 17000,
    });
    expect((await postPayout(res)).kind).toBe("ok");
    expect((await postPayout(res)).kind).toBe("already_posted");
  });
});

describe("B. calc_note（spec L913・受入 L1098: 計算根拠が残る）", () => {
  it("DB の calc_note にレートID・元金額・計算式・適用日がそのまま残る", async () => {
    const res = await insertReservation({
      therapistId: therapistA,
      offsetDays: 2,
      status: "done",
      totalAmount: 17000,
    });
    const out = await postPayout(res);
    expect(out.kind).toBe("ok");

    const rows = await sql<{ category: string; amount: number; calc_note: unknown }[]>`
      select category::text as category, amount, calc_note
      from payout_lines
      where reservation_id = ${res}::uuid and category = 'course'
    `;
    expect(rows).toHaveLength(1);
    // jsonb がオブジェクトで返る = 二重エンコードされていない
    const note = rows[0]!.calc_note as {
      rateId: string;
      scope: string;
      baseAmount: number;
      rateValue: number;
      formula: string;
      effectiveFrom: string;
      businessDate: string;
    };
    expect(typeof note).toBe("object");
    expect(note.baseAmount).toBe(17000);
    expect(note.rateValue).toBe(65);
    expect(note.formula).toBe("17000円 × 65% = 11050円");
    expect(note.effectiveFrom).toBe("2026-01-01");
    expect(note.businessDate).toBe(jstDate(2));
    // rateId が実在する payout_rates を指す
    const rate = await sql<{ value: number }[]>`
      select value from payout_rates where id = ${note.rateId}::uuid
    `;
    expect(rate[0]?.value).toBe(65);
  });
});

describe("C. 回数券消化でもバック（spec L917・受入 L1095）", () => {
  it("回数券で払った施術でも course のバックが立つ（現金と同額）", async () => {
    const res = await insertReservation({
      therapistId: therapistA,
      offsetDays: 3,
      status: "done",
      totalAmount: 17000,
    });
    // 回数券 3回 30,000円 を発行 → この予約で1回消化（前受金の振替）
    const sold = await sellTicketCore(sql, ownerSession, {
      customerId,
      count: 3,
      totalAmount: 30000,
    });
    expect(sold.kind).toBe("ok");
    const redeemed = await redeemTicketCore(sql, ownerSession, {
      customerId,
      reservationId: res,
    });
    expect(redeemed.kind).toBe("ok");
    ticketReservationId = res;

    const out = await postPayout(res);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const course = out.lines.find((l) => l.category === "course");
    // 現金の有無で分岐しない: 基礎はコース定価 17,000円 × 65%
    expect(course?.amount).toBe(11050);
    expect(course?.calcNote.base?.paidByTicket).toBe(true);
  });
});

describe("D. noshow は交通費のみ（spec L919 既定）", () => {
  it("無断キャンセルで移動だけ発生 → transport 行のみ", async () => {
    const res = await insertReservation({
      therapistId: therapistA,
      offsetDays: 4,
      status: "noshow",
      nominationFee: 1000,
      transportFee: 1000,
      totalAmount: 21500,
      withOption: true,
    });
    const out = await postPayout(res);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.lines.map((l) => l.category)).toEqual(["transport"]);
    expect(out.lines[0]?.amount).toBe(1000);
  });
});

describe("E/F. 締めロックと過去不変（受入 L1097・L1094）", () => {
  let payoutId: string;
  let grossAtClose: number;
  let lineAmountsAtClose: Array<{ id: string; amount: number }>;

  it("期間を締めると payouts が closed で確定する（控除つき）", async () => {
    const closed = await closePayoutPeriodCore(sql, ownerSession, {
      therapistId: therapistA,
      periodStart: jstDate(0),
      periodEnd: jstDate(10),
      deductions: [{ kind: "advance", amount: 500, note: "立替" }],
    });
    expect(closed.kind).toBe("ok");
    if (closed.kind !== "ok") return;
    payoutId = closed.payoutId;
    grossAtClose = closed.gross;
    expect(closed.gross).toBeGreaterThan(0);
    expect(closed.net).toBe(closed.gross - 500);

    lineAmountsAtClose = (
      await sql<{ id: string; amount: number }[]>`
        select id::text as id, amount from payout_lines
        where therapist_id = ${therapistA}::uuid
          and business_date >= ${jstDate(0)}::date
          and business_date <= ${jstDate(10)}::date
        order by id
      `
    ).map((r) => ({ id: r.id, amount: r.amount }));
    expect(lineAmountsAtClose.length).toBeGreaterThan(0);
  });

  it("締め済み期間への計上は拒否される（アプリ + DB トリガ）", async () => {
    const res = await insertReservation({
      therapistId: therapistA,
      offsetDays: 5,
      status: "done",
      totalAmount: 17000,
    });
    expect((await postPayout(res)).kind).toBe("period_closed");

    // DB トリガが最終防衛線（アプリのチェックを飛ばした直接 insert も拒否）
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`
          insert into payout_lines
            (therapist_id, business_date, reservation_id, category, amount,
             calc_note, created_by)
          values (${therapistA}::uuid, ${jstDate(5)}::date, ${res}::uuid,
                  'course', 100, '{}'::jsonb, ${OWNER_USER}::uuid)
        `;
      }),
    ).rejects.toMatchObject({ code: "P0018" });
  });

  it("締め済み payouts の変更・削除・控除追加が拒否される（受入 L1097）", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`update payouts set gross = 1 where id = ${payoutId}::uuid`;
      }),
    ).rejects.toMatchObject({ code: "P0019" });
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`delete from payouts where id = ${payoutId}::uuid`;
      }),
    ).rejects.toMatchObject({ code: "P0019" });
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`
          insert into payout_deductions (payout_id, kind, amount)
          values (${payoutId}::uuid, 'supplies', 100)
        `;
      }),
    ).rejects.toMatchObject({ code: "P0019" });
  });

  it("修正は逆仕訳のみ: 当日日付の打ち消し行が立ち、締め済みの保存値は動かない", async () => {
    const target = lineAmountsAtClose[0]!;
    const reversed = await reversePayoutLineCore(sql, ownerSession, {
      lineId: target.id,
      reason: "計上誤り",
    });
    expect(reversed.kind).toBe("ok");
    if (reversed.kind !== "ok") return;

    const rev = await sql<
      { amount: number; business_date: string; reversal_of: string }[]
    >`
      select amount, to_char(business_date, 'YYYY-MM-DD') as business_date,
             reversal_of::text as reversal_of
      from payout_lines where id = ${reversed.reversalId}::bigint
    `;
    expect(rev[0]?.amount).toBe(-target.amount);
    expect(rev[0]?.reversal_of).toBe(target.id);
    // 逆仕訳は当日日付 = open 期間に入る（締め済み期間の外）
    expect(rev[0]?.business_date).toBe(reversed.businessDate);
    expect(rev[0]!.business_date < jstDate(0)).toBe(true);

    // 二重逆仕訳は DB unique が拒否
    const again = await reversePayoutLineCore(sql, ownerSession, {
      lineId: target.id,
      reason: "二重",
    });
    expect(again.kind).toBe("already_reversed");

    // 締め済み payouts の保存値は不変
    const p = await sql<{ gross: number }[]>`
      select gross from payouts where id = ${payoutId}::uuid
    `;
    expect(p[0]?.gross).toBe(grossAtClose);
  });

  it("★レート改定後も、確定済みの報酬が変わらない（受入 L1094）", async () => {
    // A の個別コースレートを 65% → 70% に改定（今日から適用）
    const today = new Date().toISOString().slice(0, 10);
    const changed = await upsertPayoutRateCore(sql, ownerSession, {
      therapistId: therapistA,
      rankId: null,
      targetType: "course",
      targetId: null,
      calcType: "rate",
      value: 70,
      effectiveFrom: today,
    });
    expect(changed.kind).toBe("ok");
    if (changed.kind !== "ok") return;
    expect(changed.cappedCount).toBe(1); // 旧 65% が打ち切られた（値は不変）

    // 確定済み期間の行は 1 行も変わっていない
    const after = await sql<{ id: string; amount: number }[]>`
      select id::text as id, amount from payout_lines
      where therapist_id = ${therapistA}::uuid
        and business_date >= ${jstDate(0)}::date
        and business_date <= ${jstDate(10)}::date
        and reversal_of is null
      order by id
    `;
    expect(after.map((r) => ({ id: r.id, amount: r.amount }))).toEqual(
      lineAmountsAtClose,
    );
    // payouts の確定値も不変
    const p = await sql<{ gross: number }[]>`
      select gross from payouts where id = ${payoutId}::uuid
    `;
    expect(p[0]?.gross).toBe(grossAtClose);
    // 旧レート行の value も 65 のまま（打ち切りのみ / 履歴保存）
    const old = await sql<{ value: number; effective_to: string | null }[]>`
      select value, to_char(effective_to, 'YYYY-MM-DD') as effective_to
      from payout_rates
      where therapist_id = ${therapistA}::uuid and target_type = 'course'
        and value = 65
    `;
    expect(old[0]?.effective_to).toBe(today);
  });

  it("closed → paid は記録でき、それ以外の変更は拒否される", async () => {
    const paid = await markPayoutPaidCore(sql, ownerSession, { payoutId });
    expect(paid.kind).toBe("ok");
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`update payouts set net = 1 where id = ${payoutId}::uuid`;
      }),
    ).rejects.toMatchObject({ code: "P0019" });
  });

  it("重複する期間の締めは exclusion 制約で拒否される", async () => {
    const overlap = await closePayoutPeriodCore(sql, ownerSession, {
      therapistId: therapistA,
      periodStart: jstDate(8),
      periodEnd: jstDate(20),
    });
    expect(overlap.kind).toBe("overlap");
  });
});

describe("G/H. RLS と追記専用（受入 L1134 / spec 13-3）", () => {
  it("therapist は自分の payout_lines のみ見える。他人の行は 0 行", async () => {
    const seenByA = await withUser(sql, sessionA, (tx) =>
      tx<{ therapist_id: string }[]>`select therapist_id from payout_lines`,
    );
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((r) => r.therapist_id === therapistA)).toBe(true);

    // B のセッションで A の行を狙い撃ちしても 0 行（受入 L1134）
    const stolen = await withUser(sql, sessionB, (tx) =>
      tx<{ id: string }[]>`
        select id from payout_lines where therapist_id = ${therapistA}::uuid
      `,
    );
    expect(stolen).toHaveLength(0);

    // payouts も同様（A の支払履歴は B から見えない）
    const payoutsSeenByB = await withUser(sql, sessionB, (tx) =>
      tx<{ id: string }[]>`
        select id from payouts where therapist_id = ${therapistA}::uuid
      `,
    );
    expect(payoutsSeenByB).toHaveLength(0);
  });

  it("getMyEarningsCore は本人の分だけを返す（RLS 経由）", async () => {
    const a = await getMyEarningsCore(sql, sessionA, {
      fromDate: jstDate(0),
      toDate: jstDate(10),
    });
    expect(a.kind).toBe("ok");
    if (a.kind !== "ok") return;
    expect(a.earnings.range.total).toBeGreaterThan(0);
    expect(a.earnings.range.byCategory.course).toBeGreaterThan(0);
    expect(a.earnings.payouts.length).toBeGreaterThan(0);
    expect(a.earnings.confirmedNetTotal).toBe(grossOf(a.earnings.payouts));

    const b = await getMyEarningsCore(sql, sessionB, {
      fromDate: jstDate(0),
      toDate: jstDate(10),
    });
    expect(b.kind).toBe("ok");
    if (b.kind !== "ok") return;
    // B は自分の 2 予約分のみ（A の高額分が混ざらない）
    expect(b.earnings.range.byCategory.course).toBe(9350 + 9350);
    expect(b.earnings.payouts).toHaveLength(0);

    // owner セッションでは forbidden（本人専用）
    const o = await getMyEarningsCore(sql, ownerSession, {
      fromDate: jstDate(0),
      toDate: jstDate(10),
    });
    expect(o.kind).toBe("forbidden");
  });

  function grossOf(
    payouts: ReadonlyArray<{ status: string; net: number }>,
  ): number {
    return payouts
      .filter((p) => p.status !== "open")
      .reduce((s, p) => s + p.net, 0);
  }

  it("payout_lines の update/delete は permission denied (42501)", async () => {
    await expect(
      withUser(sql, ownerSession, async (tx) => {
        await tx`update payout_lines set amount = 1 where therapist_id = ${therapistA}::uuid`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withUser(sql, sessionA, async (tx) => {
        await tx`delete from payout_lines where therapist_id = ${therapistA}::uuid`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("therapist は他人のレート（個別）は見えないが、既定・ランク別は見える", async () => {
    const ratesSeenByB = await withUser(sql, sessionB, (tx) =>
      tx<{ therapist_id: string | null }[]>`
        select therapist_id from payout_rates
      `,
    );
    expect(ratesSeenByB.length).toBeGreaterThan(0);
    // A の個別レートは B からは見えない
    expect(ratesSeenByB.every((r) => r.therapist_id !== therapistA)).toBe(true);
  });
});

describe("補助: 設定・グリッド", () => {
  it("payout_policy の既定: 値引前基礎・回数券/ポイント含める（spec L848・L917・L920）", async () => {
    const settings = await loadPayoutSettings(sql);
    expect(settings).toEqual({
      discountBase: "before",
      includePointUseInBase: true,
      includeTicketRedeemInBase: true,
    });
  });

  it("getPayoutRatesGridCore がランク・セラピスト・レートを返す", async () => {
    const grid = await getPayoutRatesGridCore(sql, ownerSession);
    expect(grid.ranks.length).toBeGreaterThanOrEqual(3);
    expect(grid.therapists.some((t) => t.id === therapistA)).toBe(true);
    expect(grid.rates.some((r) => r.therapistId === therapistA)).toBe(true);
  });
});
