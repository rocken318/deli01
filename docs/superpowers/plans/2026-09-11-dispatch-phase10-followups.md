# 配車表 フェーズ10（詰め: バック単価表・受付車要否・当日精算取消）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 3つの詰め残しを実装する。(A) 当日給料の単価を編集する**バック単価表**画面（既存 payout_rates fixed を再利用）。(B) **電話受付フォームに配車の車要否チェック**を追加（作成時に反映）。(C) **当日精算の取消/再精算**。

**Architecture:** すべて既存の仕組みの上の追加。マイグレーション無し。A=`upsertPayoutRate`(calcType='fixed')＋`getPayoutRatesGrid` を再利用した新画面。B=`createPhoneOrder` は触らず、作成後に既存 `setReservationDispatchNeeds` を呼ぶ＋フォームに連動チェック。C=`daily_payouts` の行削除で取消（`payout_lines` 台帳は不変）。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。設計 8章 確認事項の残。

---

## 前提（実装者は該当ファイルを読んで配線する）
- 既存 payout: `src/lib/payout/actions.ts` の `getPayoutRatesGrid()` / `upsertPayoutRate({ targetType, targetId, calcType:'fixed', value, effectiveFrom })`（fixed=円・owner/admin のみ）。`upsertPayoutRate` は既存レートを打ち切り新行追加（履歴保存）。
- 車要否: `src/lib/dispatch-board/needs-actions.ts` の `setReservationDispatchNeeds({ reservationId, needsSendCar, needsReturnCar })`（manage_reservations）。
- 電話受付: `src/app/(admin)/admin/orders/{actions.ts,OrderEntryForm.tsx}`。`createPhoneOrder`（actions.ts）の**返り値の予約ID**を使う（実装者が形を確認：成功時に reservationId 相当を返すはず。無ければ actions.ts に露出させる最小変更可）。
- 当日給料: `src/lib/payout/todays-pay-actions.ts` の `getTodaysPay`/`settleTodaysPay`／`daily_payouts`（0036・therapist×business_date 一意）。UI `src/app/(admin)/admin/todays-pay/TodaysPayClient.tsx`。
- ナビ: `src/app/(admin)/_components/admin-nav-model.ts`。

---

## Task A: バック単価表 画面（既存 payout_rates fixed 再利用）

**Files:** Create `src/lib/payout/back-prices-actions.ts`（`listBackPriceTargets`）＋ `tests/integration/ztest-back-prices.test.ts`; Create `src/app/(admin)/admin/back-prices/{page.tsx,BackPricesClient.tsx}`; Modify `admin-nav-model.ts`（「会計・報酬」に `{ href:"/admin/back-prices", label:"バック単価表" }`）

仕様:
- `listBackPriceTargets()`（manage_cms 参照）→ コース・オプション・指名の**現行 fixed 既定単価**（therapist_id/rank_id とも null・target_id 指定）を返す:
  `{ courses:[{id,name,durationMin,backYen}], options:[{id,name,backYen}], nominationBackYen }`。
  backYen は payout_rates で `calc_type='fixed'` かつ該当 target の**現在有効な既定行**の value（無ければ null）。courses/options は `courses`/`options` テーブルから（is_active）。指名は target_type='nomination'・target_id null の既定。
- 画面 `/admin/back-prices`: 受付表「自動精算表」風の表（コース: 分＋単価入力／OP: 名＋単価入力／指名: 単価入力）。保存で各行 `upsertPayoutRate({ targetType, targetId, calcType:'fixed', value, effectiveFrom: 今日 })`。owner/admin のみ編集可。**率(%)ではなく円**であることを明示。管理側日本語直書き可・`any` 禁止。整数円。

- [ ] **Step 1: `listBackPriceTargets` の統合テスト（TDD）** `ztest-back-prices.test.ts`: seed の course/option に対し upsertPayoutRate(fixed) 相当で単価を入れ（またはアクション経由）、listBackPriceTargets が backYen を返すことを検証。1〜3ケース。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** `back-prices-actions.ts` 実装（`getClient`/`withUser`/`can(manage_cms)`。getPayoutRatesGridCore を参考に、fixed かつ既定スコープの現行行を target 別に拾う）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** 画面＋ナビ実装。`upsertPayoutRate` は既存 action をそのまま呼ぶ。
- [ ] **Step 6:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 7:** `git add src/lib/payout/back-prices-actions.ts tests/integration/ztest-back-prices.test.ts "src/app/(admin)/admin/back-prices" "src/app/(admin)/_components/admin-nav-model.ts" && git commit -m "feat(dispatch): バック単価表 画面（コース/OP/指名の円単価・payout_rates fixed 再利用）"`

---

## Task B: 電話受付フォームに車要否チェック

**Files:** Modify `src/app/(admin)/admin/orders/{OrderEntryForm.tsx,actions.ts}`

仕様:
- OrderEntryForm に「🚗 配車」ブロック（**配車する＝送り＋帰り 既定ON・送り→帰り連動**・帰りだけ外せる。両OFF＝配車不要）。予約詳細の `DispatchNeeds.tsx` の連動ロジックに倣う。
- 予約作成成功後（`createPhoneOrder` の返り値の予約ID）に `setReservationDispatchNeeds({ reservationId, needsSendCar, needsReturnCar })` を呼ぶ。**両方 ON（既定）なら DB default=true と同じなので呼ばなくてよい**（どちらか OFF のときだけ呼ぶ、で可）。
- `createPhoneOrder` の内部（createHold）は変更しない。返り値に reservationId が無ければ actions.ts で露出させる最小変更のみ可。

- [ ] **Step 1:** actions.ts を読み `createPhoneOrder` の返り値（予約ID）を確認。無ければ露出。
- [ ] **Step 2:** OrderEntryForm に配車ブロック＋作成後の `setReservationDispatchNeeds` 呼び出しを追加。
- [ ] **Step 3:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。既存の phone-order 統合テストが緑のまま（`pnpm test -- tests/integration/phone-order.test.ts`）。
- [ ] **Step 4:** `git add "src/app/(admin)/admin/orders" && git commit -m "feat(dispatch): 電話受付フォームに配車の車要否チェック（作成時反映）"`

---

## Task C: 当日精算の取消/再精算

**Files:** Modify `src/lib/payout/todays-pay-actions.ts`; Modify `tests/integration/ztest-todays-pay.test.ts`; Modify `src/app/(admin)/admin/todays-pay/TodaysPayClient.tsx`

仕様: `unsettleTodaysPay({ therapistId, dateISO })`（manage_reservations）＝`daily_payouts` の該当行を削除（`payout_lines` 台帳は不変＝現金手渡しの記録の取消のみ）。取消後は `getTodaysPay` で settled=false に戻り、再精算できる。

- [ ] **Step 1: テスト追記（TDD）** `ztest-todays-pay.test.ts` に「精算→取消→settled=false→再精算できる」ケースを追加。
- [ ] **Step 2:** Run `pnpm test -- tests/integration/ztest-todays-pay.test.ts` → 新ケース FAIL。
- [ ] **Step 3:** `unsettleTodaysPay` を実装（`delete from daily_payouts where therapist_id and business_date returning id`・0行なら error='未精算です'・revalidate）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** TodaysPayClient の精算済み行に「精算取消」ボタン（確認後 `unsettleTodaysPay`→再取得）。
- [ ] **Step 6:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 7:** `git add src/lib/payout/todays-pay-actions.ts tests/integration/ztest-todays-pay.test.ts "src/app/(admin)/admin/todays-pay/TodaysPayClient.tsx" && git commit -m "feat(dispatch): 当日精算の取消/再精算（daily_payouts 行削除）"`

---

## Task D: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（ztest-back-prices・ztest-todays-pay 追記込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 設計8章 確認事項の A(バック単価表)/B(受付車要否)/C(取消) を実装。バック単価は payout_rates fixed を再利用し二重定義を回避。
- Placeholder: C は完全コード指示。A/B は既存 action（upsertPayoutRate/setReservationDispatchNeeds）を再利用＋該当ファイル読取で配線（実装者向け具体指示）。
- リスク: createHold/createPhoneOrder のengineは不変（Bは作成後に needs を設定）。daily_payouts 削除は payout_lines を触らない（会計不変）。upsertPayoutRate は履歴保存（既存値を書き換えない）。
- 型整合: `listBackPriceTargets`（A）／`unsettleTodaysPay`（C）を各 UI が使用。既存 `setReservationDispatchNeeds`/`upsertPayoutRate`/`getTodaysPay` を再利用。
