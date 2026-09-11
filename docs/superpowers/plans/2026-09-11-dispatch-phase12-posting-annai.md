# 配車表 フェーズ12（計上の一本化＋案内表の車要否）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** (A) 会計・報酬で分かれている手動「計上」を **1つに統一**（売上を計上すれば報酬も同時計上）。(B) **案内表の予約ポップからも配車の車要否チェック**を入力できるようにする。

**Architecture:** A=既存 `postReservationAccounting(reservationId)`（売上＋報酬を冪等・一括計上／`src/lib/accounting/actions.ts`）に、会計画面と報酬画面の計上ボタンを**両方寄せる**。B=案内表 `BookingPopup` に配車ブロック（送り＋帰り連動）を追加し、作成後 `setReservationDispatchNeeds` を呼ぶ（Phase10 の OrderEntryForm 対応と同型）。マイグレーション無し。

**Tech Stack:** Next.js 15 / TS / Vitest。

---

## 前提（実装者は該当ファイルを読む）
- `src/lib/accounting/actions.ts` `postReservationAccounting(reservationId)` = 売上(revenue_lines)＋報酬(payout_lines) を冪等一括計上。二重計上は既存 unique 制約で防止。
- 会計画面: `src/app/(admin)/admin/accounting/AccountingClient.tsx`（現在の計上ボタンは `postReservationRevenue` 系を呼ぶはず）。
- 報酬画面: `src/app/(admin)/admin/payouts/PayoutsClient.tsx`（未計上一覧＝`listUnpostedPayoutReservations`→`postReservationPayout`）。
- 案内表ポップ: `src/app/(admin)/admin/annai/BookingPopup.tsx`（`createPhoneOrder` 経由で作成。返り値に reservationId）。予約詳細の `src/app/(admin)/admin/reservations/[id]/DispatchNeeds.tsx` の連動ロジックを流用。
- 車要否: `src/lib/dispatch-board/needs-actions.ts` `setReservationDispatchNeeds({reservationId, needsSendCar, needsReturnCar})`。

---

## Task A: 計上の一本化

**Files:** Modify `src/app/(admin)/admin/accounting/AccountingClient.tsx`, `src/app/(admin)/admin/payouts/PayoutsClient.tsx`

要件:
- 両画面の「計上」ボタンのハンドラを **`postReservationAccounting(reservationId)`** 呼び出しに変更（売上＋報酬を同時計上）。呼び出し後は各画面の一覧を再取得（両方の未計上リストが減る）。
- ボタン文言/補足に「売上＋報酬を計上」と分かるようにする（管理側日本語直書き可）。
- `postReservationAccounting` は import 追加（`@/lib/accounting/actions`）。既存の revenue-only/payout-only アクションは残してよい（他から使われていれば）。
- `any` 禁止。

- [ ] **Step 1:** AccountingClient / PayoutsClient を読み、計上ボタンのハンドラを `postReservationAccounting` へ差し替え。
- [ ] **Step 2:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。既存の会計/報酬統合テストが緑（`pnpm test -- tests/integration/auto-post-on-done.test.ts` 他）。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/accounting/AccountingClient.tsx" "src/app/(admin)/admin/payouts/PayoutsClient.tsx" && git commit -m "feat(dispatch): 計上を一本化（売上計上＝報酬も同時計上・postReservationAccounting）"`

---

## Task B: 案内表ポップの車要否チェック

**Files:** Modify `src/app/(admin)/admin/annai/BookingPopup.tsx`

要件:
- BookingPopup に「🚗 配車」ブロック（**配車する＝送り＋帰り 既定ON・送り→帰り連動・帰りだけ外せる**）。`DispatchNeeds.tsx` の連動ロジックに倣う。
- 予約作成成功後（`createPhoneOrder` の返り値 reservationId）に `setReservationDispatchNeeds({reservationId, needsSendCar, needsReturnCar})` を呼ぶ（**両方 ON＝既定なら呼ばなくてよい**。どちらか OFF のときだけ呼ぶ）。
- 既存のポップの挙動（枠選択・作成・総額表示）は保持。`any` 禁止。

- [ ] **Step 1:** BookingPopup を読み、配車ブロック＋作成後の needs 設定を追加。
- [ ] **Step 2:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。既存 annai 統合テスト緑（`pnpm test -- tests/integration/annai-booking-slots.test.ts`）。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/annai/BookingPopup.tsx" && git commit -m "feat(dispatch): 案内表の予約ポップに配車の車要否チェック"`

---

## Task C: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 計上一本化＝Task A（既存 postReservationAccounting 再利用）／案内表車要否＝Task B（Phase10 と同型）。
- Placeholder: 既存 action 再利用＋該当ファイル読取で配線（実装者向け具体指示）。UI のみ・新規テスト不要（呼ぶ action は既存テスト済み）。
- リスク: engine/台帳は不変（呼び先を既存の冪等 action へ変えるだけ）。二重計上は既存 unique で防止。createHold 不変。
