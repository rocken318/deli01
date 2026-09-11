# 配車表 フェーズ11（予約一覧）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 日ごとの予約一覧ページ `/admin/reservation-list` を作る。**既定は当日**。一覧から**電話受付と同じ入力で新規予約**でき、**派遣できるセラピストの空き時間**を併記し、**D&Dで手動表示順**の入れ替え、**IN時刻/OUT時刻でのソート切替**ができる。

**Architecture:** 予約に `manual_sort_order`（0038）を追加。`getReservationList`/`reorderReservations` を追加（統合テスト）。UI は既存 `OrderEntryForm`（電話受付フォーム・default export・props: therapists/courses/options/areas）を**そのまま再利用**して新規予約、空き時間は案内表の `listAnnaiBoardCore` を流用。D&D は手動表示順（`manual_sort_order`）を保存＝発注者確定「手動の表示順」。IN/OUT ソートはクライアント切替。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。

---

## 前提
- 最新 = `0037_direction_groups.sql` → 本フェーズ **`0038_reservation_manual_sort.sql`**。
- OrderEntryForm: `src/app/(admin)/admin/orders/OrderEntryForm.tsx`（default export・props `{therapists, courses, options, areas}`）。データ取得は `orders/page.tsx` の4クエリを流用（コピー可）。
- 空き時間: `src/lib/annai/queries.ts` の `listAnnaiBoardCore(tx, nowMs)` ＋ `src/domain/annai/window.ts`（`computeAvailableWindow`）。案内表 `page.tsx` が `BoardRow` で次案内可能を出しているので、**同じ経路**でセラピスト別の「次案内可能 from〜to」を取得して右パネルに出す（実装者は annai の取得経路を読んで薄い action か既存 export を再利用）。
- therapist ガード（0012）は allow-list ＝新列 `manual_sort_order` は therapist から自動保護。
- ナビ: `admin-nav-model.ts`。主要に「予約一覧」を追加（発注者の主要＝予約一覧/案内表/配車/当日給料）。既存の「予約管理」は「受付・配車」へ移す。**`admin-nav-model.test.ts` の主要グループ期待配列を更新**。

## File Structure
- Create `migrations/0038_reservation_manual_sort.sql`
- Create `src/lib/reservations/list-actions.ts`（`getReservationList`/`reorderReservations`）＋ `tests/integration/ztest-reservation-list.test.ts`
- Create `src/app/(admin)/admin/reservation-list/{page.tsx,ReservationListClient.tsx}`
- Modify `src/app/(admin)/_components/admin-nav-model.ts` ＋ `admin-nav-model.test.ts`

---

## Task 1: マイグレーション 0038

**Files:** Create `migrations/0038_reservation_manual_sort.sql`

```sql
-- 0038_reservation_manual_sort: 予約一覧の手動表示順（設計 フェーズ11）。
-- 時刻(start_at)は不変。表示順だけを人が D&D で決められる。null は末尾扱い（アプリ層）。
alter table reservations
  add column if not exists manual_sort_order integer;
create index if not exists reservations_manual_sort_idx
  on reservations (manual_sort_order) where manual_sort_order is not null;
```

- [ ] Run `pnpm db:migrate` → 適用。
- [ ] `git add migrations/0038_reservation_manual_sort.sql && git commit -m "feat(dispatch): 予約に manual_sort_order（一覧の手動表示順）を追加"`

---

## Task 2: 一覧取得/並べ替えアクション ＋ 統合テスト（TDD）

**Files:** Create `src/lib/reservations/list-actions.ts`, `tests/integration/ztest-reservation-list.test.ts`

仕様（manage_reservations）:
- `getReservationList(dateISO)`: 当日（start_at が Asia/Tokyo の dateISO の日）の予約を返す。status は `held/confirmed/enroute/in_service/done`（cancelled/noshow 除外）。返却各件: `{ id, therapistName, customerName, courseName, courseDurationMin, areaName, hotelName, startAtISO(IN), endAtISO(OUT), status, manualSortOrder, needsSendCar, needsReturnCar }`。既定並びは `manual_sort_order asc nulls last, start_at asc`。
- `reorderReservations({ dateISO, orderedIds })`: orderedIds の順に `manual_sort_order = index`（0..n）を一括 update（その日の予約のみ・トランザクション）。

- [ ] **Step 1: 失敗テスト** `ztest-reservation-list.test.ts`（aoi＋demo customer/address で当日予約2件を作成→getReservationList で2件・IN/OUT が返る→reorderReservations で順を反転→再取得で manualSortOrder 反映を検証。afterAll 掃除）。4〜5ケース。実 Postgres・`vi.mock('next/cache')`。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 実装（`getClient`/`withUser`/`can(manage_reservations)`。getDispatchBoardCore の join を参考に therapist 表示名＝entity_records published->>'name'、course/area/hotel を left join。held も含める点だけ getDispatchBoardCore と違う）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/lib/reservations/list-actions.ts tests/integration/ztest-reservation-list.test.ts && git commit -m "feat(dispatch): 予約一覧の取得/手動並べ替えアクション＋統合テスト"`

---

## Task 3: 予約一覧 画面 ＋ ナビ

**Files:** Create `src/app/(admin)/admin/reservation-list/{page.tsx,ReservationListClient.tsx}`; Modify `admin-nav-model.ts`＋`admin-nav-model.test.ts`

- **page.tsx**: `getDevSession`→redirect。日付＝`?date=` or 当日（Asia/Tokyo）。`dynamic='force-dynamic'`。取得: `getReservationList(date)`＋OrderEntryForm 用の therapists/courses/options/areas（`orders/page.tsx` の4クエリをコピー）＋空き時間（annai の取得経路を流用）。ReservationListClient へ渡す。
- **ReservationListClient**:
  - 日付ナビ（前日/当日/翌日・date input）。
  - **予約一覧テーブル**: 女性/コース/派遣先/IN/OUT/状態。**D&D で行を並べ替え**（HTML5 DnD・ドロップで `reorderReservations({dateISO, orderedIds})` を呼び保存）。**ソート切替ボタン**「手動順／IN順／OUT順」（IN=startAt昇順・OUT=endAt昇順・手動=manualSortOrder）。各行から予約詳細 `/admin/reservations/[id]` へリンク。
  - **右パネル「派遣できるセラピストの空き時間」**: セラピスト別の次案内可能（from〜to）を一覧（案内表と同じ算出）。
  - **新規予約**: 折りたたみ or モーダルで `OrderEntryForm` をそのまま埋め込む（props を page から渡す）。作成後は一覧を再取得。
  - 3状態（空/ローディング/エラー）。管理側日本語直書き可・`any` 禁止。
- **ナビ**: 主要グループを `[電話受付, 予約一覧(/admin/reservation-list), 案内表, 配車ボード, 当日給料]` に。**「予約管理」(/admin/reservations) は「受付・配車」グループへ移動**。`admin-nav-model.test.ts` の主要 href 期待配列を新しい5件へ更新（href 一意テストも維持）。

- [ ] **Step 1:** ナビ更新＋テスト更新 → `pnpm test -- "src/app/(admin)/_components/admin-nav-model.test.ts"` PASS。
- [ ] **Step 2:** page.tsx＋ReservationListClient.tsx 実装。
- [ ] **Step 3:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 4:** `git add "src/app/(admin)/admin/reservation-list" "src/app/(admin)/_components/admin-nav-model.ts" "src/app/(admin)/_components/admin-nav-model.test.ts" && git commit -m "feat(dispatch): 予約一覧ページ（当日既定・受付入力・空き時間・D&D手動順・IN/OUTソート）＋ナビ"`

---

## Task 4: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（ztest-reservation-list＋nav-model 更新込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 予約一覧（日別・当日既定）＝Task1-3、受付入力＝OrderEntryForm 再利用、空き時間＝annai 流用、D&D手動順＝manual_sort_order（発注者確定）、IN/OUTソート＝client。全要望に対応。
- Placeholder: migration/actions/test は完全コード。UI は既存 OrderEntryForm/annai を再利用＋要件明示（実装者が取得経路を読む）。
- 型整合: `getReservationList`/`reorderReservations`（Task2）を Task3 が使用。OrderEntryForm props（therapists/courses/options/areas）を page が供給。
- リスク: `getDispatchBoardCore` は不変（別 action `getReservationList` を新設）。ナビは主要を5件へ更新（テスト同時更新）。createHold engine 不変（新規予約は OrderEntryForm→既存 createPhoneOrder）。
