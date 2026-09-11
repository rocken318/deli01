# 配車表 フェーズ15（清算金額と売上金額を分けて表示）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 運営が **売上金額（店が客から得た額）** と **清算金額（＝セラピストへの支払＝バック − 雑費）** を別々に把握できるようにする。(1) **当日給料**にセラピスト別の**売上**を並記。(2) **日次会計**に**清算金額（バック − 雑費10%）**を明示。

**Architecture:** 既存台帳（revenue_lines / payout_lines）は不変。`getTodaysPay` に売上集計を追加し、`getDailyBooksCore` に雑費・清算金額（＝payout − 雑費）を追加。雑費率は `site_settings.payout_policy.misc_deduction_rate`（既定10・floor）。清算金額 = バック − floor(バック × 率/100)。マイグレーション無し。金銭＝整数のみ。

**Tech Stack:** Next.js 15 / TS / Vitest。設計 4.8（雑費floor確定）。

---

## 前提（実装者は該当ファイルを読む）
- `src/lib/payout/todays-pay-actions.ts`: `getTodaysPay(dateISO)` は `TodaysPayRow{ therapistId, therapistName, lines, gross, misc, pay, settled, paidAt }[]`。payout_lines を business_date=dateISO で therapist×category 集計。雑費率読取ヘルパあり（`misc_deduction_rate`）。`computeDayPay(gross, rate)`（`src/domain/payout/day-pay.ts`）。
- `src/app/(admin)/admin/todays-pay/TodaysPayClient.tsx`。
- `src/lib/accounting/daily-books.ts`: `getDailyBooksCore` → `DailyBooksResult{ storeTotal{revenue,payout,...}, therapists:TherapistBooksRow[]{...revenue,payout} }`。売上=revenue_lines（transport 除外）、バック=payout_lines（reversal込み純額）。
- `src/app/(admin)/admin/daily-books/DailyBooksClient.tsx`（店舗合計カード＝売上/バック/経費/粗利、個人別テーブル）。
- テスト: `tests/integration/ztest-todays-pay.test.ts`、`tests/integration/daily-books-g.test.ts`（既存）。

---

## Task 1: 当日給料にセラピスト別「売上」を並記

**Files:** Modify `src/lib/payout/todays-pay-actions.ts`, `tests/integration/ztest-todays-pay.test.ts`, `src/app/(admin)/admin/todays-pay/TodaysPayClient.tsx`

- `TodaysPayRow` に `revenue: number` を追加。
- `getTodaysPay`: 各 therapist の当日**売上**＝ `revenue_lines`（`line_type <> 'transport'`・reversal 込み純額＝reversal_of 込みで単純 sum）を、`occurred_at` が dateISO の Asia/Tokyo 当日範囲 [dayStart, dayEnd) にある行で therapist_id 別に合計し、対応行に載せる（payout が無く売上だけの therapist は現状 payout ベースで行が立たないが、**当面は payout がある therapist にのみ revenue を付ける**＝行集合は不変）。
- 実装: dayStart/dayEnd を `fromZonedTime(`${dateISO}T00:00:00`, 'Asia/Tokyo')`＋`addDays 1`。therapist 別 `select therapist_id, coalesce(sum(amount) filter (where line_type<>'transport'),0) from revenue_lines where occurred_at>=dayStart and occurred_at<dayEnd group by therapist_id` を map 化して各 row に revenue を代入。
- ztest-todays-pay: done 予約に revenue_lines を入れているケース（既存 fixture）に対し `getTodaysPay` の該当 row の `revenue` が期待額であることを1ケース追加。無ければ revenue_lines fixture を1行足す（`line_type='course'`・therapist・occurred_at=当日）。
- TodaysPayClient: 左一覧＝各行に「売上 ¥… / 清算 ¥…」の2値、右詳細＝**売上金額**と**清算金額（＝支払額）**を別カードで明示。合計サマリにも「本日売上合計」「本日清算合計」を並記。「清算金額＝セラピストへの支払（バック−雑費）」と分かる文言。金額は整数。

- [ ] **Step 1:** ztest-todays-pay に revenue 検証を追加（TDD・失敗確認）。
- [ ] **Step 2:** `getTodaysPay` に revenue 集計を実装 → テスト緑。
- [ ] **Step 3:** TodaysPayClient に売上並記。
- [ ] **Step 4:** `pnpm test -- tests/integration/ztest-todays-pay.test.ts` 緑＋`pnpm typecheck && pnpm lint && pnpm build`。
- [ ] **Step 5:** `git add src/lib/payout/todays-pay-actions.ts tests/integration/ztest-todays-pay.test.ts "src/app/(admin)/admin/todays-pay/TodaysPayClient.tsx" && git commit -m "feat(dispatch): 当日給料に売上金額を並記（売上と清算を別表示）"`

---

## Task 2: 日次会計に「清算金額（バック−雑費）」を明示

**Files:** Modify `src/lib/accounting/daily-books.ts`, `tests/integration/daily-books-g.test.ts`, `src/app/(admin)/admin/daily-books/DailyBooksClient.tsx`

- `TherapistBooksRow` と `storeTotal` に `misc: number`（雑費）と `settlement: number`（清算金額＝payout − misc）を追加。
- `getDailyBooksCore`: 雑費率を site_settings.payout_policy.misc_deduction_rate（既定10）から読み、**行ごと**に `misc = floor(payout × rate / 100)`、`settlement = payout − misc`。storeTotal.misc は個人別 misc の合計（＝日次の floor を積む・週月は近似だが日次運用が主）、storeTotal.settlement = storeTotal.payout − storeTotal.misc。
- **粗利・店取分の既存式は変えない**（`grossProfit = 売上 − バック − 経費` のまま）。清算金額/雑費は**情報表示の追加**。雑費は店の追加取り分である旨の注記のみ。
- daily-books-g テスト: storeTotal.settlement = payout − floor(payout×10%) を検証する1ケース追加（既存 fixture の payout に対し）。
- DailyBooksClient: 店舗合計カードに **「売上金額」** と **「清算金額（セラピスト支払＝バック−雑費）」** を並べて明示（バック/粗利は残す）。個人別テーブルに「清算」列を追加（売上・バック・雑費・清算・店取分）。「清算金額＝実際にセラピストへ手渡す額」と分かる文言。

- [ ] **Step 1:** daily-books-g に settlement 検証を追加（TDD・失敗確認）。
- [ ] **Step 2:** `getDailyBooksCore` に misc/settlement を実装 → テスト緑。
- [ ] **Step 3:** DailyBooksClient に清算金額を明示（店舗合計＋個人別列）。CSV export も清算列を足す場合は `export/route.ts` も更新（任意・やるなら列追加）。
- [ ] **Step 4:** `pnpm test -- tests/integration/daily-books-g.test.ts` 緑＋`pnpm typecheck && pnpm lint && pnpm build`。
- [ ] **Step 5:** `git add src/lib/accounting/daily-books.ts tests/integration/daily-books-g.test.ts "src/app/(admin)/admin/daily-books" && git commit -m "feat(dispatch): 日次会計に清算金額（バック−雑費）を明示（売上と清算を分離）"`

---

## Task 3: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 当日給料に売上並記＝Task1／日次会計に清算金額（バック−雑費）＝Task2。清算金額=セラピストへの支払（発注者確定）。
- Placeholder: 集計ロジック/テスト具体化。UI は既存拡張＋要件明示。
- 金銭注意: 台帳（revenue_lines/payout_lines）は read のみ・不変。雑費 floor（設計確定）。粗利の既存定義は変えない（清算/雑費は情報追加）。週月の雑費は日次 floor の積み上げが理想だが本フェーズは行単位 floor 近似（日次運用が主）と注記。
- 型整合: `TodaysPayRow.revenue`（Task1）／`storeTotal.misc/settlement`・`TherapistBooksRow.misc/settlement`（Task2）を各 UI が使用。
