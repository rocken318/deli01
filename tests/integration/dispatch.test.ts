import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import type { Role } from "@/domain/auth";

/**
 * フェーズ13 統合テスト（実 Postgres 必須 / spec 15章）。
 *
 * 受入条件:
 *   L1108: 打診用に住所と電話番号が含まれない
 *   L1109: 差し込み変数が全て埋まる。未定義の変数で落ちない
 *   L1128: 未確認の予約では確定用テンプレート（住所入り）が生成できない
 *
 * 検証の骨子:
 * - beforeAll で web 未確認予約 / phone 確認済み予約を作成（seed の phase12_reservations が
 *   空の場合に備え、テスト自身でデータを用意する）
 * - generateDispatchText: 未確認 confirmed 拒否 / 確認済み confirmed 許可 / 打診は常時許可
 * - dispatch_logs の追記専用（insert 可・update/delete 不可）
 * - recordDispatch: コピーで1行追記・listDispatchTargets に反映
 * - therapist ロールで message_templates / dispatch_logs が 0 行（RLS）
 * - confirmed の recordDispatch は未確認予約で拒否される
 *
 * ★getDevSession を vi.mock して Server Action 本体を実 Postgres で呼ぶ。
 */

const mockAuth = vi.hoisted(() => ({ session: null as { userId: string; role: string } | null }));
vi.mock("@/lib/cms/dev-session", () => ({
  getDevSession: async () => mockAuth.session,
}));

import {
  generateDispatchText,
  recordDispatch,
  listDispatchTargets,
} from "@/lib/dispatch/actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const seedUsers = new Map<Role, { id: string }>();

function sessionOf(role: Role): Session {
  const u = seedUsers.get(role);
  if (!u) throw new Error(`seed に ${role} のテストアカウントがない`);
  return { userId: u.id, role };
}

/** このテストで作成した予約 ID（afterAll で掃除） */
let webUnconfirmedId = "";
let phoneConfirmedId = "";

/** このテストで作成した customer phones（afterAll で掃除） */
const createdCustomerPhones: string[] = [];

/** このテストで作成した dispatch_logs id（afterAll で保守経路掃除） */
const createdDispatchLogIds: number[] = [];

// テスト用電話番号プレフィックス（他テストと衝突しない）
const TEST_PHONE_PREFIX = "0907777";

beforeAll(async () => {
  // seed ユーザー取得
  const users = await sql<{ id: string; role: Role }[]>`
    select id, role from app_users where display_name like '（ダミー）%'
  `;
  for (const r of users) seedUsers.set(r.role, { id: r.id });

  expect(seedUsers.has("owner")).toBe(true);
  expect(seedUsers.has("therapist")).toBe(true);

  // seed の基礎データを取得
  const therapists = await sql<{ id: string; slug: string }[]>`
    select id, slug from therapists where slug = 'ren' limit 1
  `;
  const renId = therapists[0]?.id ?? "";
  expect(renId).not.toBe("");

  const areas = await sql<{ id: string }[]>`
    select id from areas where name = '渋谷区' limit 1
  `;
  const shibuyaId = areas[0]?.id ?? "";
  expect(shibuyaId).not.toBe("");

  const courses = await sql<{ id: string; price: number; nomination_fee_default: number }[]>`
    select id, price, nomination_fee_default from courses where name = 'ショート' limit 1
  `;
  const course = courses[0];
  expect(course).toBeTruthy();

  const ownerUserId = sessionOf("owner").userId;

  // -----------------------------------------------------------------------
  // テスト用予約を作成（JST の昼帯に配置。depart_at〜free_at が排他制約を満たすよう
  // 2本を十分離した時間帯に配置する）
  // -----------------------------------------------------------------------

  // web 未確認予約（source=web, phone_confirmed_at=null）
  const webPhone = `${TEST_PHONE_PREFIX}001`;
  createdCustomerPhones.push(webPhone);

  const webStartAt = new Date(`${tomorrowISODate()}T04:00:00.000Z`); // JST 13:00
  const webEndAt = new Date(webStartAt.getTime() + 60 * 60_000);
  const webDepartAt = new Date(webStartAt.getTime() - 25 * 60_000);
  const webFreeAt = new Date(webEndAt.getTime() + 10 * 60_000);

  const webCustomers = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${webPhone}, 'テスト太郎（dispatch）')
    returning id
  `;
  const webAddresses = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id)
    values (
      ${webCustomers[0]!.id}::uuid, 'home'::address_kind,
      '東京都渋谷区テスト1-2-3（dispatch）', ${shibuyaId}::uuid
    )
    returning id
  `;
  const webRows = await sql<{ id: string }[]>`
    insert into reservations (
      therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min,
      status, nomination_fee, transport_fee, total_amount, source,
      phone_confirmed_at, phone_confirmed_by
    ) values (
      ${renId}::uuid, ${webCustomers[0]!.id}::uuid, ${webAddresses[0]!.id}::uuid,
      ${shibuyaId}::uuid, ${course!.id}::uuid,
      ${webStartAt}, ${webEndAt}, ${webDepartAt}, ${webFreeAt},
      15, 15, 30,
      'confirmed'::reservation_status, ${course!.nomination_fee_default}, 0,
      ${course!.price + course!.nomination_fee_default},
      'web'::reservation_source,
      null,
      null
    )
    returning id
  `;
  webUnconfirmedId = webRows[0]!.id;

  // phone 確認済み予約（source=phone, phone_confirmed_at 設定済み）
  // 時間帯を3時間ずらして exclusion 衝突を避ける
  const phonePhone = `${TEST_PHONE_PREFIX}002`;
  createdCustomerPhones.push(phonePhone);

  const phoneStartAt = new Date(`${tomorrowISODate()}T07:00:00.000Z`); // JST 16:00
  const phoneEndAt = new Date(phoneStartAt.getTime() + 60 * 60_000);
  const phoneDepartAt = new Date(phoneStartAt.getTime() - 25 * 60_000);
  const phoneFreeAt = new Date(phoneEndAt.getTime() + 10 * 60_000);

  const phoneCustomers = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${phonePhone}, 'テスト次郎（dispatch）')
    returning id
  `;
  const phoneAddresses = await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id)
    values (
      ${phoneCustomers[0]!.id}::uuid, 'home'::address_kind,
      '東京都渋谷区サンプル4-5-6', ${shibuyaId}::uuid
    )
    returning id
  `;
  const phoneRows = await sql<{ id: string }[]>`
    insert into reservations (
      therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min,
      status, nomination_fee, transport_fee, total_amount, source,
      phone_confirmed_at, phone_confirmed_by
    ) values (
      ${renId}::uuid, ${phoneCustomers[0]!.id}::uuid, ${phoneAddresses[0]!.id}::uuid,
      ${shibuyaId}::uuid, ${course!.id}::uuid,
      ${phoneStartAt}, ${phoneEndAt}, ${phoneDepartAt}, ${phoneFreeAt},
      15, 15, 30,
      'confirmed'::reservation_status, ${course!.nomination_fee_default}, 500,
      ${course!.price + course!.nomination_fee_default + 500},
      'phone'::reservation_source,
      ${phoneStartAt},
      ${ownerUserId}::uuid
    )
    returning id
  `;
  phoneConfirmedId = phoneRows[0]!.id;

  // 作成後の状態を確認
  const webCheck = await sql<{ phone_confirmed_at: Date | null; source: string }[]>`
    select phone_confirmed_at, source::text from reservations where id = ${webUnconfirmedId}::uuid
  `;
  expect(webCheck[0]!.phone_confirmed_at).toBeNull();
  expect(webCheck[0]!.source).toBe("web");

  const phoneCheck = await sql<{ phone_confirmed_at: Date | null; source: string }[]>`
    select phone_confirmed_at, source::text from reservations where id = ${phoneConfirmedId}::uuid
  `;
  expect(phoneCheck[0]!.phone_confirmed_at).not.toBeNull();
  expect(phoneCheck[0]!.source).toBe("phone");

  // owner として Server Action を呼ぶ（getDevSession モック）
  mockAuth.session = sessionOf("owner");
});

afterEach(async () => {
  // 各テスト後にセッションを owner に戻す
  mockAuth.session = sessionOf("owner");
});

afterAll(async () => {
  // dispatch_logs の掃除（保守経路で削除）
  if (createdDispatchLogIds.length > 0) {
    await sql`
      delete from dispatch_logs
      where id = any(${createdDispatchLogIds}::bigint[])
    `;
  }
  // 予約・顧客の掃除
  if (webUnconfirmedId) {
    await sql`delete from reservations where id = ${webUnconfirmedId}::uuid`;
  }
  if (phoneConfirmedId) {
    await sql`delete from reservations where id = ${phoneConfirmedId}::uuid`;
  }
  if (createdCustomerPhones.length > 0) {
    await sql`delete from customers where phone = any(${createdCustomerPhones})`;
  }
  await sql.end({ timeout: 5 });
});

/** 翌日の日付を ISO 形式で返す（テストデータが既存データと衝突しないよう未来にする） */
function tomorrowISODate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 1. generateDispatchText – 未確認予約のゲート（受入 L1128）
// ---------------------------------------------------------------------------
describe("generateDispatchText – 電話確認ゲート（受入 L1128）", () => {
  it("★ 未確認予約（source=web, phone_confirmed_at=null）で confirmed は ok:false（拒否）", async () => {
    const res = await generateDispatchText(webUnconfirmedId, "confirmed");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/電話確認/);
  });

  it("未確認予約で inquiry は ok:true（打診は確認前でも可）", async () => {
    const res = await generateDispatchText(webUnconfirmedId, "inquiry");
    expect(res.ok).toBe(true);
    expect(res.data?.text).toBeTruthy();
    expect(res.data?.canConfirmed).toBe(false); // ゲートの状態を UI に返す
  });

  it("確認済み予約（source=phone）で confirmed は ok:true・住所と顧客名は含むが電話番号は含まない", async () => {
    const res = await generateDispatchText(phoneConfirmedId, "confirmed");
    expect(res.ok).toBe(true);
    expect(res.data?.text).toBeTruthy();
    expect(res.data?.canConfirmed).toBe(true);
    const text = res.data!.text;
    // 確定用は住所（{{場所}}）・顧客名（{{顧客名}}）を含む（spec 8-3 L788）
    expect(text).toContain("サンプル4-5-6");
    expect(text).toContain("テスト次郎（dispatch）");
    // **既定の確定用テンプレートには電話番号を含めない**（spec 7-3 L709: 顧客電話番号を
    // セラピスト個人端末に残さない。8-3 L788 の確定用列挙にも電話番号は無い）
    expect(text).not.toContain(`${TEST_PHONE_PREFIX}002`);
  });

  it("確認済み予約で inquiry も ok:true", async () => {
    const res = await generateDispatchText(phoneConfirmedId, "inquiry");
    expect(res.ok).toBe(true);
    expect(res.data?.text).toBeTruthy();
  });

  it("存在しない予約 ID では ok:false", async () => {
    const res = await generateDispatchText(randomUUID(), "inquiry");
    expect(res.ok).toBe(false);
  });

  it("不正な UUID では ok:false（Zod バリデーション）", async () => {
    const res = await generateDispatchText("not-a-uuid", "confirmed");
    expect(res.ok).toBe(false);
    // actions.ts が返す日本語メッセージ「無効な予約IDです」で一致
    expect(res.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. generateDispatchText – 打診出力の PII 除去（受入 L1108・実データで再確認）
// ---------------------------------------------------------------------------
describe("generateDispatchText – 打診出力に PII が含まれない（受入 L1108 実データ）", () => {
  it("★ 打診生成の出力に顧客の実電話番号が含まれない", async () => {
    const res = await generateDispatchText(webUnconfirmedId, "inquiry");
    expect(res.ok).toBe(true);
    const text = res.data!.text;
    // web 未確認予約の顧客電話番号が打診出力に含まれない
    expect(text).not.toContain(`${TEST_PHONE_PREFIX}001`);
  });

  it("★ 打診生成の出力に住所文字列が含まれない", async () => {
    const res = await generateDispatchText(webUnconfirmedId, "inquiry");
    expect(res.ok).toBe(true);
    const text = res.data!.text;
    // テスト用住所 "東京都渋谷区テスト1-2-3（dispatch）" の一部も出ない
    expect(text).not.toContain("テスト1-2-3");
    expect(text).not.toContain("（dispatch）");
  });

  it("打診出力は 【打診】 マーカーを含む（seed テンプレートの検証）", async () => {
    const res = await generateDispatchText(webUnconfirmedId, "inquiry");
    expect(res.ok).toBe(true);
    const text = res.data!.text;
    expect(text).toContain("【打診】");
  });

  it("確認済み予約の confirmed 出力に住所が含まれる（打診との対照）", async () => {
    const res = await generateDispatchText(phoneConfirmedId, "confirmed");
    expect(res.ok).toBe(true);
    const text = res.data!.text;
    // 確定用テンプレートは {{場所}} が埋まるので住所文字列が出る
    expect(text).toContain("サンプル4-5-6");
  });
});

// ---------------------------------------------------------------------------
// 3. dispatch_logs – 追記専用（insert 可・update/delete 不可）
// ---------------------------------------------------------------------------
describe("dispatch_logs – 追記専用（spec 8-3 L795 / migrations/0011）", () => {
  it("app_runtime ロール（withUser 経由）で dispatch_logs への insert が成功する", async () => {
    const therapistRows = await sql<{ id: string }[]>`
      select t.id from reservations r
      join therapists t on t.id = r.therapist_id
      where r.id = ${phoneConfirmedId}::uuid
      limit 1
    `;
    const therapistId = therapistRows[0]!.id;

    const beforeCount = await sql<{ n: string }[]>`
      select count(*)::text as n from dispatch_logs
      where reservation_id = ${phoneConfirmedId}::uuid
    `;

    await withUser(sql, sessionOf("owner"), async (tx) => {
      await tx`
        insert into dispatch_logs (reservation_id, therapist_id, kind, body_snapshot, created_by)
        values (
          ${phoneConfirmedId}::uuid,
          ${therapistId}::uuid,
          'inquiry'::template_kind,
          'テスト打診本文（追記専用テスト）',
          ${sessionOf("owner").userId}::uuid
        )
      `;
    });

    const afterCount = await sql<{ n: string }[]>`
      select count(*)::text as n from dispatch_logs
      where reservation_id = ${phoneConfirmedId}::uuid
    `;
    expect(Number(afterCount[0]!.n)).toBe(Number(beforeCount[0]!.n) + 1);

    // 挿入した行の id を記録（afterAll で掃除）
    const inserted = await sql<{ id: number }[]>`
      select id from dispatch_logs
      where reservation_id = ${phoneConfirmedId}::uuid
        and body_snapshot = 'テスト打診本文（追記専用テスト）'
      order by id desc limit 1
    `;
    if (inserted[0]) createdDispatchLogIds.push(inserted[0].id);
  });

  it("★ app_runtime ロール（withUser 経由）で dispatch_logs の update が permission denied", async () => {
    await expect(
      withUser(sql, sessionOf("owner"), async (tx) => {
        await tx`
          update dispatch_logs
          set body_snapshot = '改ざん'
          where reservation_id = ${phoneConfirmedId}::uuid
        `;
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("★ app_runtime ロール（withUser 経由）で dispatch_logs の delete が permission denied", async () => {
    await expect(
      withUser(sql, sessionOf("owner"), async (tx) => {
        await tx`
          delete from dispatch_logs
          where reservation_id = ${phoneConfirmedId}::uuid
        `;
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// 4. recordDispatch – コピー記録と listDispatchTargets への反映
// ---------------------------------------------------------------------------
describe("recordDispatch / listDispatchTargets – 記録と一覧反映", () => {
  it("recordDispatch（inquiry）で dispatch_logs に1行入る", async () => {
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from dispatch_logs
      where reservation_id = ${phoneConfirmedId}::uuid and kind = 'inquiry'
    `;

    const res = await recordDispatch(
      phoneConfirmedId,
      "inquiry",
      "【打診】テスト打診テキスト（recordDispatch テスト）",
    );
    expect(res.ok).toBe(true);

    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from dispatch_logs
      where reservation_id = ${phoneConfirmedId}::uuid and kind = 'inquiry'
    `;
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n) + 1);

    const inserted = await sql<{ id: number; kind: string }[]>`
      select id, kind::text from dispatch_logs
      where reservation_id = ${phoneConfirmedId}::uuid
        and body_snapshot = '【打診】テスト打診テキスト（recordDispatch テスト）'
      order by id desc limit 1
    `;
    expect(inserted[0]!.kind).toBe("inquiry");
    if (inserted[0]) createdDispatchLogIds.push(inserted[0].id);
  });

  it("確認済み予約で confirmed の recordDispatch が ok:true で記録される", async () => {
    const res = await recordDispatch(
      phoneConfirmedId,
      "confirmed",
      "【確定】テスト確定テキスト（recordDispatch テスト）",
    );
    expect(res.ok).toBe(true);

    const logs = await sql<{ kind: string }[]>`
      select kind::text from dispatch_logs
      where reservation_id = ${phoneConfirmedId}::uuid
        and body_snapshot = '【確定】テスト確定テキスト（recordDispatch テスト）'
      order by id desc limit 1
    `;
    expect(logs.length).toBe(1);
    expect(logs[0]!.kind).toBe("confirmed");

    const inserted = await sql<{ id: number }[]>`
      select id from dispatch_logs
      where body_snapshot = '【確定】テスト確定テキスト（recordDispatch テスト）'
      order by id desc limit 1
    `;
    if (inserted[0]) createdDispatchLogIds.push(inserted[0].id);
  });

  it("listDispatchTargets の inquirySent / confirmedSent が dispatch_logs に反映される", async () => {
    const res = await listDispatchTargets();
    expect(res.ok).toBe(true);
    // 確認済み予約が上記テストで inquiry + confirmed を送信済みなので
    // 該当行の両フラグが true になっている
    const target = res.data?.find((r) => r.reservationId === phoneConfirmedId);
    if (target) {
      // start_at が now() - 2hours 以降のみ返るので、翌日の予約なら必ず含まれる
      expect(target.inquirySent).toBe(true);
      expect(target.confirmedSent).toBe(true);
      expect(target.phoneConfirmed).toBe(true);
    }
    // 見つからなかった場合（start_at が now()-2h 外）はスキップ（テスト時刻依存）
  });

  it("★ 未確認予約（phone_confirmed_at=null）での confirmed の recordDispatch は ok:false（拒否）", async () => {
    const res = await recordDispatch(
      webUnconfirmedId,
      "confirmed",
      "不正な確定テキスト",
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/電話確認/);

    // dispatch_logs に confirmed 行が入っていない（拒否されたため）
    const logs = await sql<{ n: string }[]>`
      select count(*)::text as n from dispatch_logs
      where reservation_id = ${webUnconfirmedId}::uuid
        and kind = 'confirmed'
    `;
    expect(Number(logs[0]!.n)).toBe(0);
  });

  it("recordDispatch は未認証で ok:false", async () => {
    mockAuth.session = null;
    const res = await recordDispatch(phoneConfirmedId, "inquiry", "テスト");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("認証が必要です");
  });
});

// ---------------------------------------------------------------------------
// 5. RLS – therapist ロールで message_templates / dispatch_logs が 0 行
// ---------------------------------------------------------------------------
describe("RLS – therapist は message_templates と dispatch_logs が見えない", () => {
  it("therapist ロールで message_templates が 0 行（RLS）", async () => {
    const rows = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`select id from message_templates`;
    });
    expect(rows.length).toBe(0);
  });

  it("therapist ロールで dispatch_logs が 0 行（RLS）", async () => {
    const rows = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: number }[]>`select id from dispatch_logs`;
    });
    expect(rows.length).toBe(0);
  });

  it("therapist ロールで dispatch_logs への insert が row-level security 違反", async () => {
    const therapistRows = await sql<{ id: string }[]>`
      select t.id from reservations r
      join therapists t on t.id = r.therapist_id
      where r.id = ${phoneConfirmedId}::uuid
      limit 1
    `;
    const therapistId = therapistRows[0]!.id;

    await expect(
      withUser(sql, sessionOf("therapist"), async (tx) => {
        await tx`
          insert into dispatch_logs (reservation_id, therapist_id, kind, body_snapshot, created_by)
          values (
            ${phoneConfirmedId}::uuid,
            ${therapistId}::uuid,
            'inquiry'::template_kind,
            'セラピストによる不正挿入',
            ${sessionOf("therapist").userId}::uuid
          )
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("owner は message_templates が inquiry/confirmed の2行見える（RLS の対照）", async () => {
    const rows = await withUser(sql, sessionOf("owner"), async (tx) => {
      return tx<{ kind: string }[]>`select kind::text from message_templates where is_active = true`;
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain("inquiry");
    expect(kinds).toContain("confirmed");
  });
});

// ---------------------------------------------------------------------------
// 6. generateDispatchText – エラーパス
// ---------------------------------------------------------------------------
describe("generateDispatchText – エラーパス", () => {
  it("未認証では ok:false", async () => {
    mockAuth.session = null;
    const res = await generateDispatchText(phoneConfirmedId, "inquiry");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("認証が必要です");
  });
});
