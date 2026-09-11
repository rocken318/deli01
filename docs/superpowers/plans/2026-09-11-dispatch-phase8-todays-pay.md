# 配車表 フェーズ8（当日給料＝日払い精算）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** セラピストの帰り際に、その日のバックを集計して即精算（現金手渡し）できる「当日給料」画面を作る。**支払額 = その日の確定バック合計 − 雑費（合計の10%・切り捨て）**。バックは既存 `payout_lines` 台帳（完了時に自動計上済み）を源泉に集計する。

**Architecture:** バック額は既存の報酬エンジン（`payout_rates` fixed/率＋`payout_lines`・フェーズ18＋#95 自動計上）を**そのまま源泉**に使う。当日給料 = 当該日の `payout_lines` 合計 − 雑費(10%)。雑費率は `site_settings.payout_policy.misc_deduction_rate`（既定10）。精算は追記専用 `daily_payouts`（therapist×営業日で一意）に記録。計算は純関数（TDD）。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。**金銭＝整数円のみ・雑費は切り捨て（floor）確定（2026-09-11 発注者）**。設計 4.8・5.5。参考モック `.superpowers/brainstorm/1464-1789071838/content/todays-pay-v2.html`。

---

## 前提
- 最新 = `0035_transport_ledger.sql` → 本フェーズ **`0036_daily_payouts.sql`**。
- `payout_lines`（0016）: therapist_id・business_date(date)・category(payout_category)・amount(整数円・追記専用)。完了予約は #95 `postReservationAccounting` で自動計上済み。集計は `business_date = dateISO` で行う（reception の当日）。
- `site_settings.payout_policy`（jsonb）に `misc_deduction_rate` を追加（既定10）。読取は key='payout_policy' の value から。
- 当日給料は reception が帰り際に精算する運用 → 参照/精算 = manage_reservations。
- ナビ「主要」に「当日給料」を追加（フェーズ1で保留していたピン）。

## File Structure
- Create `migrations/0036_daily_payouts.sql`
- Create `src/domain/payout/day-pay.ts`（`computeDayPay`）＋ `.test.ts`
- Create `src/lib/payout/todays-pay-actions.ts`（`getTodaysPay`/`settleTodaysPay`）＋ `tests/integration/ztest-todays-pay.test.ts`
- Create `src/app/(admin)/admin/todays-pay/{page.tsx,TodaysPayClient.tsx}`
- Modify `src/app/(admin)/_components/admin-nav-model.ts`（主要に `{ href:"/admin/todays-pay", label:"当日給料" }`）＋ `admin-nav-model.test.ts`（主要グループの期待 href 配列に追加）

---

## Task 1: マイグレーション 0036

**Files:** Create `migrations/0036_daily_payouts.sql`

```sql
-- 0036_daily_payouts: 当日給料（日払い精算）の記録（設計 4.8/5.5）。追記専用。
-- 支払額 = gross − misc（雑費=floor(gross*rate/100)）。therapist×営業日で一意。
-- RLS: 参照/精算 = owner/admin/reception。

create table if not exists daily_payouts (
  id             uuid primary key default gen_random_uuid(),
  therapist_id   uuid not null references therapists (id) on delete restrict,
  business_date  date not null,
  gross          integer not null,
  misc           integer not null,
  net            integer not null,
  paid_at        timestamptz not null default now(),
  paid_by        uuid references app_users (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint daily_payouts_uniq unique (therapist_id, business_date),
  constraint daily_payouts_net_check check (net = gross - misc),
  constraint daily_payouts_nonneg_check check (gross >= 0 and misc >= 0)
);

create index if not exists daily_payouts_date_idx on daily_payouts (business_date);

alter table daily_payouts enable row level security;
alter table daily_payouts force row level security;

drop policy if exists daily_payouts_staff on daily_payouts;
create policy daily_payouts_staff on daily_payouts
  for all using (app_current_role() in ('owner','admin','reception'))
  with check (app_current_role() in ('owner','admin','reception'));

grant select, insert, update, delete on daily_payouts to app_runtime;

-- 雑費率（既定10%）を payout_policy へ（切り捨てはアプリ層 floor）
update site_settings
set value = value || '{"misc_deduction_rate": 10}'::jsonb
where key = 'payout_policy' and not value ? 'misc_deduction_rate';
```

- [ ] Run `pnpm db:migrate` → 適用。
- [ ] `git add migrations/0036_daily_payouts.sql && git commit -m "feat(dispatch): daily_payouts（当日給料精算）＋雑費率既定10%"`

---

## Task 2: 当日給料の計算（純関数・TDD）

**Files:** Create `src/domain/payout/day-pay.ts`, `.test.ts`

- [ ] **Step 1: 失敗テスト** `src/domain/payout/day-pay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeDayPay } from "./day-pay";

describe("computeDayPay（雑費=合計×率%・切り捨て）", () => {
  it("15000×10% → 雑費1500・支払13500", () => {
    expect(computeDayPay(15000, 10)).toEqual({ gross: 15000, misc: 1500, pay: 13500 });
  });
  it("32000×10% → 雑費3200・支払28800", () => {
    expect(computeDayPay(32000, 10)).toEqual({ gross: 32000, misc: 3200, pay: 28800 });
  });
  it("端数は切り捨て: 15005×10% → 雑費1500・支払13505", () => {
    expect(computeDayPay(15005, 10)).toEqual({ gross: 15005, misc: 1500, pay: 13505 });
  });
  it("0円は雑費0", () => {
    expect(computeDayPay(0, 10)).toEqual({ gross: 0, misc: 0, pay: 0 });
  });
  it("率0%は雑費0", () => {
    expect(computeDayPay(10000, 0)).toEqual({ gross: 10000, misc: 0, pay: 10000 });
  });
});
```

- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 実装 `src/domain/payout/day-pay.ts`:

```ts
/**
 * 当日給料（日払い精算）の計算（設計 4.8）。整数円のみ。
 * 支払額 = 合計 − 雑費、雑費 = floor(合計 × 率% / 100)（切り捨て確定）。
 */
export interface DayPay { gross: number; misc: number; pay: number; }

export function computeDayPay(gross: number, miscRatePercent: number): DayPay {
  const misc = Math.floor((gross * miscRatePercent) / 100);
  return { gross, misc, pay: gross - misc };
}
```

- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/domain/payout/day-pay.ts src/domain/payout/day-pay.test.ts && git commit -m "feat(dispatch): 当日給料の計算（雑費切り捨て・純関数）"`

---

## Task 3: 当日給料 Server Actions ＋ 統合テスト（TDD）

**Files:** Create `src/lib/payout/todays-pay-actions.ts`, `tests/integration/ztest-todays-pay.test.ts`

仕様（manage_reservations）:
- `getTodaysPay(dateISO)`: 当日（`payout_lines.business_date = dateISO`）にバックのある therapist ごとに、category 別内訳＋`computeDayPay(gross, rate)`＋精算状態（daily_payouts 有無）を返す。rate は payout_policy.misc_deduction_rate（既定10）。
  返却: `{ therapistId, therapistName, lines:[{category, amount}], gross, misc, pay, settled, paidAt }[]`。
- `settleTodaysPay({ therapistId, dateISO })`: その日の gross/misc/net を計算し `daily_payouts` へ insert（`on conflict (therapist_id, business_date) do nothing`）。既に精算済みなら `already` を返す。paid_by=session.userId。

- [ ] **Step 1: 失敗テスト** `tests/integration/ztest-todays-pay.test.ts`（aoi therapist に payout_lines を直接投入して集計を検証。business_date は固定日。afterAll で投入した payout_lines と daily_payouts を削除）:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
import { getTodaysPay, settleTodaysPay } from "@/lib/payout/todays-pay-actions";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let aoiId: string;
const DAY = "2099-09-09"; // 衝突回避の未来日

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;
  // course 20000 + option 5000 + nomination 3000 = gross 28000
  await sql`insert into payout_lines (therapist_id, business_date, category, amount, calc_note)
            values (${aoiId}::uuid, ${DAY}::date, 'course', 20000, ${sql.json({ t: "test" })})`;
  await sql`insert into payout_lines (therapist_id, business_date, category, amount, calc_note)
            values (${aoiId}::uuid, ${DAY}::date, 'nomination', 3000, ${sql.json({ t: "test" })})`;
  // option 行は option_id 必須なので seed の option を1件使う
  const optId = (await sql<{ id: string }[]>`select id from options limit 1`)[0]!.id;
  await sql`insert into payout_lines (therapist_id, business_date, category, amount, option_id, calc_note)
            values (${aoiId}::uuid, ${DAY}::date, 'option', 5000, ${optId}::uuid, ${sql.json({ t: "test" })})`;
});

afterAll(async () => {
  await sql`delete from daily_payouts where therapist_id = ${aoiId}::uuid and business_date = ${DAY}::date`;
  await sql`delete from payout_lines where therapist_id = ${aoiId}::uuid and business_date = ${DAY}::date`;
  await sql.end({ timeout: 5 });
});

describe("getTodaysPay", () => {
  it("当日のバックを集計し雑費10%切り捨てで支払額を出す", async () => {
    const r = await getTodaysPay(DAY);
    expect(r.ok).toBe(true);
    const me = r.data?.find((x) => x.therapistId === aoiId)!;
    expect(me.gross).toBe(28000);
    expect(me.misc).toBe(2800);
    expect(me.pay).toBe(25200);
    expect(me.settled).toBe(false);
  });
});

describe("settleTodaysPay", () => {
  it("精算を記録し、再取得で settled=true", async () => {
    const s = await settleTodaysPay({ therapistId: aoiId, dateISO: DAY });
    expect(s.ok).toBe(true);
    const r = await getTodaysPay(DAY);
    expect(r.data?.find((x) => x.therapistId === aoiId)?.settled).toBe(true);
  });
  it("二重精算は already（冪等・追記専用）", async () => {
    const s = await settleTodaysPay({ therapistId: aoiId, dateISO: DAY });
    expect(s.ok).toBe(true);
    expect(s.data?.already).toBe(true);
  });
});
```

- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 実装 `src/lib/payout/todays-pay-actions.ts`。骨子:
  - 雑費率: `select value from site_settings where key='payout_policy'` → `value.misc_deduction_rate ?? 10`（number）。
  - `getTodaysPay`: `select therapist_id, category, sum(amount) as amount from payout_lines where business_date = date group by therapist_id, category`（RLS 経由）＋ therapist 表示名（`therapists` join `entity_records` published->>'name'）＋ `daily_payouts` の有無/paid_at。therapist ごとに gross=Σamount、`computeDayPay(gross, rate)`、lines 内訳。
  - `settleTodaysPay`: gross を同じ集計で算出→`computeDayPay`→`insert into daily_payouts (...) on conflict (therapist_id, business_date) do nothing returning id`。0行なら already=true。
  - 型:

```ts
export interface DayPayLine { category: string; amount: number; }
export interface TodaysPayRow {
  therapistId: string; therapistName: string; lines: DayPayLine[];
  gross: number; misc: number; pay: number; settled: boolean; paidAt: string | null;
}
```
  すべて `getDevSession`→`can(manage_reservations)`→`withUser`→`ActionResult`。`computeDayPay`（Task2）を使用。`any` 禁止。

- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/lib/payout/todays-pay-actions.ts tests/integration/ztest-todays-pay.test.ts && git commit -m "feat(dispatch): 当日給料の集計/精算アクション＋統合テスト"`

---

## Task 4: 当日給料 画面 ＋ ナビ（主要ピン）

**Files:** Create `src/app/(admin)/admin/todays-pay/{page.tsx,TodaysPayClient.tsx}`; Modify `admin-nav-model.ts`＋`admin-nav-model.test.ts`

参考 `todays-pay-v2.html`。要件:
- page.tsx: `getDevSession`→redirect・日付は `?date=` or 当日（Asia/Tokyo）・`getTodaysPay(date)`→client。`dynamic='force-dynamic'`。
- TodaysPayClient: 左＝本日の女性（氏名＋支払額＋精算済/未バッジ）・合計/未精算サマリ。右＝選択女性の精算（category 別内訳→gross、雑費(10%)、支払額、手渡し現金、「この場で精算（支払済みにする）」→`settleTodaysPay`）。日付ナビ。3状態。管理側日本語直書き可・`any` 禁止・**金額は整数表示**。
- ナビ「主要」に「当日給料」追加。**`admin-nav-model.test.ts` の主要グループ期待 href 配列に `/admin/todays-pay` を追加**（順序: orders/annai/dispatch-board/reservations/**todays-pay** の末尾）。

- [ ] **Step 1:** ナビ追加＋テスト更新（主要4→5件）。
- [ ] **Step 2:** page.tsx＋TodaysPayClient.tsx 実装。
- [ ] **Step 3:** Run `pnpm test -- "src/app/(admin)/_components/admin-nav-model.test.ts"` → PASS。
- [ ] **Step 4:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 5:** `git add "src/app/(admin)/admin/todays-pay" "src/app/(admin)/_components/admin-nav-model.ts" "src/app/(admin)/_components/admin-nav-model.test.ts" && git commit -m "feat(dispatch): 当日給料 画面（内訳/雑費/支払・精算）＋主要ナビ"`

---

## Task 5: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（day-pay 単体＋ztest-todays-pay＋nav-model 更新込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 設計4.8/5.5（当日給料＝単価表×本数−雑費10%切捨・本数自動＝payout_lines源泉・精算）＝Task1-4。バック単価は既存 payout_rates/payout_lines を源泉に使い二重定義を避ける。雑費 floor 確定。
- Placeholder: migration/純関数/actions/test は完全コード。UI は既存 admin パターン＋モック参照＋要件。
- 型整合: `computeDayPay`/`DayPay`（Task2）を Task3 が使用。`TodaysPayRow`/`DayPayLine`/`getTodaysPay`/`settleTodaysPay`（Task3）を Task4 UI が使用。ナビ主要は 5 件に更新（テストも同時更新）。
- 金銭注意: 追記専用 daily_payouts（unique・net=gross−misc check）。二重精算は on conflict do nothing で冪等。集計は payout_lines を読むのみ（台帳を書き換えない）。
