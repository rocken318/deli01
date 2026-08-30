import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { DEFAULT_BOOKING_FEES } from "@/domain/booking";
import { DEFAULT_PAYOUT_SETTINGS } from "@/domain/payout";
import type { FlashDealConfig } from "@/domain/flashdeal";
import { applyFlashDealCore } from "@/lib/flashdeal/queries";
import { DEFAULT_FLASH_DEAL_CONFIG, loadFlashDealConfig } from "@/lib/flashdeal/config";
import { enqueueDueReminders } from "@/lib/notify/reminders";
import { postReservationPayoutCore } from "@/lib/payout/queries";

/**
 * フェーズ20 統合テスト（実 Postgres 必須 / migrations 0017 適用済み前提）。
 *
 * A. (受入 L1120) 直前割が CMS 設定（時間帯・発火時刻・当日・1日上限）に従って
 *    適用され、上限を超えない
 * B. (受入 L1121) 割引が revenue_lines の discount 負行として計上され、
 *    バック計算の基礎が payout_policy.discount_base の設定どおりになる
 *    （フェーズ18 buildReservationPayout との結合）
 * C. 二重適用の拒否（アプリ判定 + DB unique(reservation_id) の最終防衛線）
 * D. (受入 L1131) リマインドが前日・2時間前に1件ずつだけ生成され、
 *    dedupe_key の unique が重複を DB 層で拒否する
 * E. RLS / 追記専用: therapist は notifications を見えない。flash_deals の
 *    update / notifications の delete は grant されていない（42501）
 *
 * 前提: pnpm db:reset 済み。専用のセラピスト2名をこのテストが作る。
 * 直前割の対象日は +40日（now を注入して「当日」を再現。実時計に依存しない）。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const OWNER_USER = "aaaaaaaa-0000-4000-8000-000000000001";
const ownerSession: Session = { userId: OWNER_USER, role: "owner" };

const SUFFIX = String(Date.now() + 20).slice(-6);
const PHONE = "0905" + SUFFIX;

let therapistA = "";
let therapistB = "";
let therapistUserA = "";
let therapistSessionA: Session;
let customerId = "";
let addressId = "";
let areaId = "";
let courseId = "";

const DAY = 24 * 60 * 60 * 1000;
// 直前割の対象日: +40日の UTC 日付を基準に、JST の時刻を UTC 時で固定する
// （10:00 UTC = 19:00 JST。同じ UTC 日の 00:00-14:59 UTC は必ず同じ JST 日）
const flashDay = new Date(Date.now() + 40 * DAY);
flashDay.setUTCHours(0, 0, 0, 0);

/** flashDay の hourUtc 時（JST = hourUtc + 9） */
function flashAt(hourUtc: number, offsetDays = 0): Date {
  return new Date(flashDay.getTime() + offsetDays * DAY + hourUtc * 3_600_000);
}

/** 「当日 16:00 JST（発火 15 時を過ぎた）」の now */
const NOW_ELIGIBLE = flashAt(7); // 07:00 UTC = 16:00 JST

// flash_deals は追記専用で、対象日の適用件数はテストの再実行を跨いで累積する。
// 1日上限は「実行開始時点の件数 + 2」に動的化し、実行間で独立にする
//（beforeAll で確定。適用1件目・2件目 = 上限ちょうど、3件目 = 超過）。
let baseCount = 0;
let CONFIG: FlashDealConfig;

async function insertReservation(params: {
  therapistId: string;
  start: Date;
  status?: string;
  totalAmount?: number;
}): Promise<string> {
  const start = params.start;
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
       20, 20, 0, ${params.status ?? "confirmed"}::reservation_status,
       0, 0, ${params.totalAmount ?? 16000})
    returning id
  `;
  return rows[0]!.id;
}

function pgCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

// 直前割の対象予約（beforeAll で作成）
let res1 = ""; // A / 19:00 JST 当日 → 適用1件目
let res2 = ""; // B / 19:00 JST 当日 → 適用2件目（= 上限到達）
let res3 = ""; // A / 21:00 JST 当日 → 上限超過で拒否・各種 eligibility 検証にも使う
let res4 = ""; // A / 翌日 19:00 JST → not_same_day
let res5 = ""; // B / 21:00 JST 当日 status=done → bad_status
let res6 = ""; // B / 23:00 JST 当日 total=5 → zero_discount

beforeAll(async () => {
  const tA = await sql<{ id: string }[]>`
    insert into therapists (slug, status) values (${"p20a-" + SUFFIX}, 'active')
    returning id
  `;
  therapistA = tA[0]!.id;
  const tB = await sql<{ id: string }[]>`
    insert into therapists (slug, status) values (${"p20b-" + SUFFIX}, 'active')
    returning id
  `;
  therapistB = tB[0]!.id;

  const uA = await sql<{ id: string }[]>`
    insert into app_users (role, display_name, therapist_id)
    values ('therapist', 'P20-A', ${therapistA}::uuid)
    returning id
  `;
  therapistUserA = uA[0]!.id;
  therapistSessionA = {
    userId: therapistUserA,
    role: "therapist",
    therapistId: therapistA,
  };

  const c = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE}, 'P20顧客') returning id
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
    values (${customerId}::uuid, 'home', 'P20テスト住所', ${areaId}::uuid)
    returning id
  `;
  addressId = ad[0]!.id;

  // 個別レート（course 50%）: 個別 > ランク > 既定なので seed のレートに勝ち、
  // バック検証（B）の期待値を決定的にする
  for (const tid of [therapistA, therapistB]) {
    await sql`
      insert into payout_rates
        (therapist_id, target_type, calc_type, value, effective_from)
      values (${tid}::uuid, 'course', 'rate', 50, '2026-01-01')
    `;
  }

  res1 = await insertReservation({ therapistId: therapistA, start: flashAt(10) });
  res2 = await insertReservation({ therapistId: therapistB, start: flashAt(10) });
  res3 = await insertReservation({ therapistId: therapistA, start: flashAt(12) });
  res4 = await insertReservation({
    therapistId: therapistA,
    start: flashAt(10, 1),
  });
  res5 = await insertReservation({
    therapistId: therapistB,
    start: flashAt(12),
    status: "done",
  });
  res6 = await insertReservation({
    therapistId: therapistB,
    start: flashAt(14),
    totalAmount: 5,
  });

  const cnt = await sql<{ n: number }[]>`
    select count(*)::int as n from flash_deals
    where applied_on = (${NOW_ELIGIBLE}::timestamptz at time zone 'Asia/Tokyo')::date
  `;
  baseCount = cnt[0]!.n;
  CONFIG = {
    enabled: true,
    ratePercent: 10,
    windowFromHour: 18,
    windowToHour: 24,
    dailyLimit: baseCount + 2,
    courseIds: [],
    triggerHour: 15,
  };
});

afterAll(async () => {
  await sql.end();
});

// ---------------------------------------------------------------------------
// 0. CMS 設定ローダ
// ---------------------------------------------------------------------------

describe("0. flash_deal_config ローダ", () => {
  it("0017 の既定は enabled=false（発注者が CMS で有効化するまで金が動かない）", async () => {
    const config = await loadFlashDealConfig(sql);
    expect(config.enabled).toBe(false);
    expect(config).toEqual({ ...DEFAULT_FLASH_DEAL_CONFIG, enabled: false });
  });
});

// ---------------------------------------------------------------------------
// A. 直前割の適用と1日上限（受入 L1120）
// ---------------------------------------------------------------------------

describe("A. 直前割: 設定に従った適用と1日上限（受入 L1120）", () => {
  it("対象条件を満たす予約に適用され、discount 負行が立つ", async () => {
    const out = await applyFlashDealCore(sql, ownerSession, {
      reservationId: res1,
      config: CONFIG,
      now: NOW_ELIGIBLE,
    });
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") return;
    expect(out.discount).toBe(1600); // floor(16000 × 10%)
    expect(out.ratePercent).toBe(10);

    // 割引 = revenue_lines の discount 負行（spec L653）
    const lines = await sql<{ amount: number; line_type: string }[]>`
      select amount, line_type::text from revenue_lines
      where reservation_id = ${res1}::uuid and line_type = 'discount'
    `;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.amount).toBe(-1600);

    // 適用履歴 + 公開ラベル用の印
    const deals = await sql<
      { rate_percent: number; amount: number; revenue_line_id: string }[]
    >`
      select rate_percent, amount, revenue_line_id::text
      from flash_deals where reservation_id = ${res1}::uuid
    `;
    expect(deals).toHaveLength(1);
    expect(deals[0]!.amount).toBe(1600);
    const flag = await sql<{ is_flash_deal: boolean; total_amount: number }[]>`
      select is_flash_deal, total_amount from reservations where id = ${res1}::uuid
    `;
    expect(flag[0]!.is_flash_deal).toBe(true);
    // total_amount は割引前のまま（バック基礎の残差計算を壊さない / 二重控除防止）
    expect(flag[0]!.total_amount).toBe(16000);
  });

  it("2件目まで適用でき、3件目は1日上限（daily_limit = 既存 + 2）で拒否される", async () => {
    const out2 = await applyFlashDealCore(sql, ownerSession, {
      reservationId: res2,
      config: CONFIG,
      now: NOW_ELIGIBLE,
    });
    expect(out2.kind).toBe("applied");

    const out3 = await applyFlashDealCore(sql, ownerSession, {
      reservationId: res3,
      config: CONFIG,
      now: NOW_ELIGIBLE,
    });
    expect(out3).toEqual({ kind: "not_eligible", reason: "daily_limit_reached" });

    // 当日の適用は上限ちょうど（既存 + 今回の2件）のまま
    const cnt = await sql<{ n: number }[]>`
      select count(*)::int as n from flash_deals
      where applied_on = (${NOW_ELIGIBLE}::timestamptz at time zone 'Asia/Tokyo')::date
    `;
    expect(cnt[0]!.n).toBe(baseCount + 2);
  });

  it("設定・時間・状態による拒否（disabled / 発火前 / 時間帯外 / コース外 / 翌日 / 状態 / 0円）", async () => {
    const apply = (
      reservationId: string,
      config: FlashDealConfig,
      now: Date,
    ) => applyFlashDealCore(sql, ownerSession, { reservationId, config, now });

    expect(await apply(res3, { ...CONFIG, enabled: false }, NOW_ELIGIBLE)).toEqual({
      kind: "not_eligible",
      reason: "disabled",
    });
    // 14:00 JST = 発火（15時）前
    expect(await apply(res3, CONFIG, flashAt(5))).toEqual({
      kind: "not_eligible",
      reason: "before_trigger",
    });
    // res3 は 21:00 JST 開始 → 窓 [18,20) の外
    expect(
      await apply(res3, { ...CONFIG, windowFromHour: 18, windowToHour: 20 }, NOW_ELIGIBLE),
    ).toEqual({ kind: "not_eligible", reason: "outside_window" });
    // 対象コース指定に含まれない
    expect(
      await apply(
        res3,
        { ...CONFIG, dailyLimit: baseCount + 100, courseIds: ["00000000-0000-4000-8000-000000000000"] },
        NOW_ELIGIBLE,
      ),
    ).toEqual({ kind: "not_eligible", reason: "course_not_covered" });
    // 翌日の枠は「当日」でない（spec L652）
    expect(await apply(res4, { ...CONFIG, dailyLimit: baseCount + 100 }, NOW_ELIGIBLE)).toEqual({
      kind: "not_eligible",
      reason: "not_same_day",
    });
    // done は適用不可（事後改変）
    expect(await apply(res5, { ...CONFIG, dailyLimit: baseCount + 100 }, NOW_ELIGIBLE)).toEqual({
      kind: "bad_status",
      status: "done",
    });
    // 開始済み（now = 22:00 JST > start 21:00 JST）
    expect(await apply(res3, { ...CONFIG, dailyLimit: baseCount + 100 }, flashAt(13))).toEqual({
      kind: "already_started",
    });
    // 割引額が 0 円に切り捨てられる場合は計上しない（revenue_lines の nonzero 保護）
    expect(await apply(res6, { ...CONFIG, dailyLimit: baseCount + 100 }, NOW_ELIGIBLE)).toEqual({
      kind: "zero_discount",
    });
  });
});

// ---------------------------------------------------------------------------
// C. 二重適用の拒否
// ---------------------------------------------------------------------------

describe("C. 二重適用防止", () => {
  it("同一予約への再適用は already_applied", async () => {
    const out = await applyFlashDealCore(sql, ownerSession, {
      reservationId: res1,
      config: { ...CONFIG, dailyLimit: baseCount + 100 },
      now: NOW_ELIGIBLE,
    });
    expect(out).toEqual({ kind: "already_applied" });
  });

  it("DB 層でも unique(reservation_id) が直接 insert を拒否する（23505）", async () => {
    const rl = await sql<{ id: string }[]>`
      select revenue_line_id::text as id from flash_deals
      where reservation_id = ${res1}::uuid
    `;
    let code: string | undefined;
    try {
      await sql`
        insert into flash_deals
          (reservation_id, rate_percent, amount, applied_on, revenue_line_id)
        values (${res1}::uuid, 10, 100, current_date, ${rl[0]!.id}::bigint)
      `;
    } catch (e) {
      code = pgCode(e);
    }
    expect(code).toBe("23505");
  });
});

// ---------------------------------------------------------------------------
// B. バック計算の基礎が discount_base の設定どおり（受入 L1121 / フェーズ18 結合）
// ---------------------------------------------------------------------------

describe("B. 直前割 × バック基礎（受入 L1121）", () => {
  it("discount_base='before'（既定）: 割引前 16000 の 50% = 8000", async () => {
    await sql`update reservations set status = 'done' where id = ${res1}::uuid`;
    const out = await postReservationPayoutCore(sql, ownerSession, {
      reservationId: res1,
      fees: DEFAULT_BOOKING_FEES,
      settings: { ...DEFAULT_PAYOUT_SETTINGS, discountBase: "before" },
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const course = out.lines.find((l) => l.category === "course");
    expect(course?.amount).toBe(8000);
  });

  it("discount_base='after': 割引後 (16000−1600) の 50% = 7200", async () => {
    await sql`update reservations set status = 'done' where id = ${res2}::uuid`;
    const out = await postReservationPayoutCore(sql, ownerSession, {
      reservationId: res2,
      fees: DEFAULT_BOOKING_FEES,
      settings: { ...DEFAULT_PAYOUT_SETTINGS, discountBase: "after" },
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const course = out.lines.find((l) => l.category === "course");
    expect(course?.amount).toBe(7200);
  });
});

// ---------------------------------------------------------------------------
// D. リマインド（受入 L1131: 前日と2時間前に1回ずつだけ・重複送信しない）
// ---------------------------------------------------------------------------

describe("D. リマインドの生成と重複防止（受入 L1131）", () => {
  let reminderRes = "";

  it("90分後の確定予約に前日分・2時間前分が1件ずつ生成され、スタブ送信で sent になる", async () => {
    const now = new Date();
    reminderRes = await insertReservation({
      therapistId: therapistA,
      start: new Date(now.getTime() + 90 * 60_000),
    });

    const result = await enqueueDueReminders(sql, ownerSession, now);
    expect(result.enqueued).toBeGreaterThanOrEqual(2); // seed の予約分も拾い得る

    const rows = await sql<
      { kind: string; status: string; sent_at: Date | null; dedupe_key: string }[]
    >`
      select kind::text as kind, status::text as status, sent_at, dedupe_key
      from notifications
      where reservation_id = ${reminderRes}::uuid
      order by kind
    `;
    expect(rows.map((r) => r.kind).sort()).toEqual([
      "reminder_2h",
      "reminder_prev_day",
    ]);
    for (const r of rows) {
      expect(r.status).toBe("sent"); // スタブ送信（②配線までは実配信なし）
      expect(r.sent_at).not.toBeNull();
    }
  });

  it("バッチを再実行しても増えない（dedupe_key の on conflict do nothing）", async () => {
    await enqueueDueReminders(sql, ownerSession, new Date());
    const cnt = await sql<{ n: number }[]>`
      select count(*)::int as n from notifications
      where reservation_id = ${reminderRes}::uuid
    `;
    expect(cnt[0]!.n).toBe(2);
  });

  it("DB 層でも unique(dedupe_key) が重複 insert を拒否する（23505）", async () => {
    let code: string | undefined;
    try {
      await sql`
        insert into notifications
          (channel, kind, recipient, subject, body, scheduled_for, dedupe_key)
        values ('email', 'reminder_2h', ${PHONE}, 's', 'b', now(),
                ${"reminder_2h:" + reminderRes})
      `;
    } catch (e) {
      code = pgCode(e);
    }
    expect(code).toBe("23505");
  });
});

// ---------------------------------------------------------------------------
// E. RLS・追記専用
// ---------------------------------------------------------------------------

describe("E. RLS と grant（notifications / flash_deals）", () => {
  it("therapist は notifications を1行も読めない（顧客宛通知は staff のみ）", async () => {
    const rows = await withUser(sql, therapistSessionA, async (tx) => {
      return tx<{ n: number }[]>`select count(*)::int as n from notifications`;
    });
    expect(rows[0]!.n).toBe(0);
  });

  it("flash_deals は追記専用: 業務経路の update が permission denied（42501）", async () => {
    let code: string | undefined;
    try {
      await withUser(sql, ownerSession, async (tx) => {
        await tx`update flash_deals set amount = 1 where reservation_id = ${res1}::uuid`;
      });
    } catch (e) {
      code = pgCode(e);
    }
    expect(code).toBe("42501");
  });

  it("notifications は delete 不可: 送信記録を消せない（42501）", async () => {
    let code: string | undefined;
    try {
      await withUser(sql, ownerSession, async (tx) => {
        await tx`delete from notifications where reservation_id is not null`;
      });
    } catch (e) {
      code = pgCode(e);
    }
    expect(code).toBe("42501");
  });
});
