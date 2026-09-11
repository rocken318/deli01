# 配車表 フェーズ17（オプション管理＋予約一覧の金額内訳）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** (A) **オプション管理画面** `/admin/options` でオプションの選択肢を自由に作成/編集/削除できる。(B) **予約一覧**に金額内訳（**選択オプション・オプション個々の金額・交通費・合計金額**、＋コース/指名）を表示（派遣後のオプション追加時の金額判断に使う）。

**Architecture:** `options` テーブル（0006・name unique・price/duration_min/back_type/back_value/is_public/is_active/sort_order）は既存。CRUD アクション＋画面を新設（`drivers` CRUD と同型）。予約一覧は `getReservationList` に金額内訳（total_amount/transport_fee/nomination_fee/course price＋reservation_options）を追加。マイグレーション無し。金銭＝整数。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。

---

## 前提（実装者は該当ファイルを読む）
- `options`（0006）: id, name(unique), description, price(整数), duration_min, back_type(`option_back_type`=rate/fixed), back_value(rate は 0-100), is_public, is_active, sort_order。RLS は owner/admin 編集（既存 hotels/options と同様。`options` の RLS を確認し、write=manage_cms・read=staff で合わせる）。
- `reservation_options`（0008）: reservation_id, option_id, price_snapshot, duration_snapshot, back_*。予約時のスナップショット。
- `src/lib/reservations/list-actions.ts`: `getReservationList(dateISO)`→`ReservationListItem[]`（現在 courseName/duration/area/hotel/times/status/manualSortOrder/needs*）。`src/app/(admin)/admin/reservation-list/ReservationListClient.tsx`。
- CRUD/一覧＋フォーム/ナビは `src/lib/drivers/actions.ts`＋`DriversClient.tsx`＋`admin-nav-model.ts` を手本。

## File Structure
- Create `src/lib/options/actions.ts`（CRUD）＋ `tests/integration/ztest-options.test.ts`
- Create `src/app/(admin)/admin/options/{page.tsx,OptionsClient.tsx}`＋ ナビ追加
- Modify `src/lib/reservations/list-actions.ts`（金額内訳を追加）＋ `tests/integration/ztest-reservation-list.test.ts`（内訳検証）
- Modify `src/app/(admin)/admin/reservation-list/ReservationListClient.tsx`（内訳表示）

---

## Task 1: オプション CRUD ＋ 統合テスト（TDD）

**Files:** Create `src/lib/options/actions.ts`, `tests/integration/ztest-options.test.ts`

仕様（read=manage_reservations で受付も参照可・write=manage_cms）:
- `listOptionsAdmin()`: `{ id, name, description, price, durationMin, backType, backValue, isPublic, isActive, sortOrder }[]`（sort_order, name 順）。
- `createOption(input)` / `updateOption(input)` / `deleteOption(id)`。name unique 違反→「同名のオプションが既にあります」。使用中(reservation_options 参照)の delete は 23503→「使用中のため削除できません。非公開/停止にしてください」。price/back_value は整数・rate は 0-100。

- [ ] **Step 1: 失敗テスト** `ztest-options.test.ts`（drivers テスト構造。create→list→update→delete＋rate>100 拒否＋name重複拒否）。5〜6ケース。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 実装（drivers/actions.ts 同型。Zod: backType `z.enum(['rate','fixed'])`・backValue rate時 ≤100 を refine）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/lib/options/actions.ts tests/integration/ztest-options.test.ts && git commit -m "feat(dispatch): オプション CRUD アクション＋統合テスト"`

---

## Task 2: オプション管理画面 ＋ ナビ

**Files:** Create `src/app/(admin)/admin/options/{page.tsx,OptionsClient.tsx}`; Modify `admin-nav-model.ts`

- 一覧＋追加/編集/削除フォーム（名称/説明/料金/所要分/バック種別(rate|fixed)/バック値/公開/有効/並び順）。`DriversClient` の state 運用。canWrite=manage_cms。
- ナビ「コンテンツ・設定」に `{ href:"/admin/options", label:"オプション" }`。

- [ ] **Step 1:** page.tsx＋OptionsClient.tsx＋ナビ。
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/options" "src/app/(admin)/_components/admin-nav-model.ts" && git commit -m "feat(dispatch): オプション管理画面（選択肢を自由に作成）＋ナビ"`

---

## Task 3: 予約一覧に金額内訳

**Files:** Modify `src/lib/reservations/list-actions.ts`, `tests/integration/ztest-reservation-list.test.ts`, `src/app/(admin)/admin/reservation-list/ReservationListClient.tsx`

- `ReservationListItem` に追加: `coursePrice:number`, `nominationFee:number`, `transportFee:number`, `totalAmount:number`, `options:{ name:string; price:number }[]`。
- `getReservationList`: select に `r.total_amount, r.nomination_fee, r.transport_fee, co.price as course_price` を追加。オプションは別途 `select ro.reservation_id, o.name, ro.price_snapshot from reservation_options ro join options o on o.id=ro.option_id where ro.reservation_id = any(ids)` を取得し reservation ごとに束ねる（N件まとめて1クエリ）。
- ztest-reservation-list: オプション付き予約を1件作り（reservation_options を1行 insert）、`getReservationList` の該当 item の `options` に名前＋price が入り、`totalAmount`/`transportFee` が返ることを検証。1〜2ケース追加。
- ReservationListClient: 各予約行（または展開）に **選択オプション（名称＋個々¥）／交通費¥／合計¥**（コース¥・指名¥も）を表示。金額は整数・カンマ区切り。

- [ ] **Step 1:** テスト追記（TDD・失敗確認）。
- [ ] **Step 2:** `getReservationList` に内訳追加 → テスト緑。
- [ ] **Step 3:** ReservationListClient に内訳表示。
- [ ] **Step 4:** `pnpm test -- tests/integration/ztest-reservation-list.test.ts` 緑＋`pnpm typecheck && pnpm lint && pnpm build`。
- [ ] **Step 5:** `git add src/lib/reservations/list-actions.ts tests/integration/ztest-reservation-list.test.ts "src/app/(admin)/admin/reservation-list/ReservationListClient.tsx" && git commit -m "feat(dispatch): 予約一覧に金額内訳（オプション個々/交通費/合計）を表示"`

---

## Task 4: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（ztest-options＋ztest-reservation-list 更新込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: オプション管理＝Task1-2／予約一覧金額内訳＝Task3。既存 options/reservation_options を再利用しマイグレーション無し。
- Placeholder: CRUD/内訳/テスト具体化。UI は既存パターン再利用。
- 型整合: `listOptionsAdmin`/CRUD（Task1）を Task2 が使用。`ReservationListItem` 追加フィールド（Task3）を UI が使用。
- 金銭: 整数のみ。reservation_options はスナップショット（既存予約の内訳は不変）。
