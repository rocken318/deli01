# キャスト本人のNG条件（プロフィールNGメモ）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** セラピスト本人に紐づく **NG条件メモ**（例「自宅送迎NG」「深夜NG」「○○ホテルNG」「同乗NG」）を登録でき、**受付・案内表・配車ボード・予約一覧で常に見える**ようにする。実運用の案内表シートにある「NG条件メモ」に相当。

**Architecture:** `therapists.ng_note`（0040・text・null 可）を追加。編集はセラピスト管理（`/admin/therapists/[slug]`）＋一覧からの簡易編集。表示は案内表の行・配車ボードの女性セル・予約一覧の女性セル・受付の案内表ミニ／セラピスト欄にバッジ（⚠NG）＋ツールチップ/展開。金額・予約ロジックには影響しない（情報表示のみ）。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。

---

## 前提（実装者は該当ファイルを読む）
- `therapists`（0004）: id, app_user_id, slug, status, display_order, retired_at, timestamps。**NG欄は無い**。RLS は既存（owner/admin 編集・staff 参照）。
- 表示名は `entity_records.published->>'name'`（`left join entity_records er on er.entity='therapist' and er.slug=t.slug`）。各所でこのパターン。
- 表示先:
  - 案内表: `src/lib/annai/queries.ts` `listAnnaiBoardCore`（`BoardInput`）＋`src/app/(admin)/admin/annai/page.tsx`（Row の名前セル）
  - 配車ボード: `src/lib/dispatch-board/queries.ts` `DispatchBoardItem`（`therapistName`）＋`DispatchBoardClient.tsx`（女性セル）
  - 予約一覧: `src/lib/reservations/list-actions.ts` `ReservationListItem`＋`ReservationListClient.tsx`
  - 受付の案内表ミニ: `src/lib/annai/mini-actions.ts`（`getAnnaiMini`）＋`src/app/(admin)/admin/orders/AnnaiMiniBar.tsx`
  - 担当変更の候補一覧: `src/lib/reservations/therapist-actions.ts` `listAssignableTherapists`
- セラピスト管理画面: `src/app/(admin)/admin/therapists/`（一覧・詳細）。編集アクションの所在を確認して同じ流儀で追加する。

## File Structure
- Create `migrations/0040_therapist_ng_note.sql`
- Create `src/lib/therapist/ng-actions.ts`（`setTherapistNgNote`/`listTherapistNgNotes`）＋ `tests/integration/ztest-therapist-ng.test.ts`
- Modify（表示のため `ngNote` を返す）: `src/lib/annai/queries.ts`・`src/lib/annai/mini-actions.ts`・`src/lib/dispatch-board/queries.ts`・`src/lib/reservations/list-actions.ts`・`src/lib/reservations/therapist-actions.ts`
- Modify（UI）: `src/app/(admin)/admin/annai/page.tsx`・`.../dispatch-board/DispatchBoardClient.tsx`・`.../reservation-list/ReservationListClient.tsx`・`.../orders/AnnaiMiniBar.tsx`・`.../therapists`（編集欄）

---

## Task 1: マイグレーション 0040

**Files:** Create `migrations/0040_therapist_ng_note.sql`

```sql
-- 0040_therapist_ng_note: キャスト本人のNG条件メモ（案内表シートの「NG条件」相当）。
-- 例「自宅送迎NG」「深夜NG」「○○ホテルNG」「同乗NG」。受付・案内表・配車で常時表示する。
-- 予約ロジック・金額には影響しない（人が読む注意書き）。
-- RLS: 0004 の既存ポリシー（owner/admin 書込・staff 参照）が新列に適用される。

alter table therapists
  add column if not exists ng_note text;

comment on column therapists.ng_note is
  'キャスト本人のNG条件メモ（自宅送迎NG・深夜NG・特定ホテルNG 等）。表示専用。';
```

- [ ] Run `pnpm db:migrate` → 適用。
- [ ] `git add migrations/0040_therapist_ng_note.sql && git commit -m "feat(therapist): キャストのNG条件メモ列を追加"`

---

## Task 2: NG メモの取得/更新アクション（TDD）

**Files:** Create `src/lib/therapist/ng-actions.ts`, `tests/integration/ztest-therapist-ng.test.ts`

仕様:
- `listTherapistNgNotes()`（manage_reservations 参照）→ `{ therapistId, slug, name, ngNote }[]`（active のみ・display_order 順）。
- `setTherapistNgNote({ therapistId, ngNote })`（manage_cms＝owner/admin）→ 更新（空文字は null 化・最大 1000 字）。`revalidatePath('/admin/therapists','/admin/annai','/admin/dispatch-board','/admin/reservation-list','/admin/orders')`。
- テスト（`ztest-drivers.test.ts` の構造）: seed の aoi に NG を設定→`listTherapistNgNotes` に反映／空文字で null になる／1000字超は拒否。3〜4ケース。**時刻依存にしない**。

- [ ] **Step 1:** 失敗テスト → **Step 2:** FAIL → **Step 3:** 実装 → **Step 4:** 緑。
- [ ] **Step 5:** `git add src/lib/therapist/ng-actions.ts tests/integration/ztest-therapist-ng.test.ts && git commit -m "feat(therapist): NG条件メモの取得/更新アクション＋統合テスト"`

---

## Task 3: 各所のクエリで ngNote を返す（additive）

**Files:** Modify `src/lib/annai/queries.ts`, `src/lib/annai/mini-actions.ts`, `src/lib/dispatch-board/queries.ts`, `src/lib/reservations/list-actions.ts`, `src/lib/reservations/therapist-actions.ts`

- それぞれの therapists join に `t.ng_note` を追加し、返り値の型に `ngNote: string | null` を**追加のみ**（既存フィールド・並びは不変）:
  - `BoardInput`（annai/queries）→ `buildBoard` は `...r` で通すので `BoardRow` にも乗る
  - `AnnaiMiniItem`（mini-actions）
  - `DispatchBoardItem`（dispatch-board/queries）
  - `ReservationListItem`（reservations/list-actions）
  - `listAssignableTherapists` の返り値
- **既存テストを壊さないこと**（フィールド追加のみ）。

- [ ] **Step 1:** 実装 → **Step 2:** `pnpm typecheck` ＋ 関連統合テスト（annai-board-p1a / ztest-dispatch-ops / ztest-reservation-list / ztest-therapist-change）緑。
- [ ] **Step 3:** `git add src/lib && git commit -m "feat(therapist): 案内表/配車/一覧/受付ミニでNGメモを返す"`

---

## Task 4: UI 表示（バッジ＋内容）

**Files:** Modify `src/app/(admin)/admin/{annai/page.tsx,dispatch-board/DispatchBoardClient.tsx,reservation-list/ReservationListClient.tsx,orders/AnnaiMiniBar.tsx}`

- 女性名の隣に **⚠NG バッジ**（赤系 #B4453C・小さめ）を出し、**内容はその場で読める形**にする:
  - 案内表・配車ボード・予約一覧: バッジの隣に NG 本文を小さく表示（長ければ 1行省略＋`title` 属性で全文）
  - 受付の案内表ミニ（チップ）: チップ内に ⚠ を出し `title` に全文
  - 担当変更の候補一覧にも ⚠NG を出す（別の子へ振り替える時に気づける）
- NG が空なら何も出さない。管理側日本語直書き可・`any` 禁止。

- [ ] **Step 1:** 実装 → **Step 2:** `pnpm typecheck && pnpm lint && pnpm build`。
- [ ] **Step 3:** `git add "src/app/(admin)/admin" && git commit -m "feat(therapist): 各画面にNG条件バッジを表示"`

---

## Task 5: セラピスト管理で編集

**Files:** Modify `src/app/(admin)/admin/therapists/`（一覧 or 詳細ページ。実装者が構成を読んで適切な場所へ）

- セラピスト詳細（または一覧の行）に **NG条件メモの編集欄**（テキストエリア・保存ボタン → `setTherapistNgNote`）。owner/admin のみ編集可（reception は閲覧のみ）。
- 保存でトースト＋再読込。

- [ ] **Step 1:** 実装 → **Step 2:** `pnpm typecheck && pnpm lint && pnpm build`。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/therapists" && git commit -m "feat(therapist): セラピスト管理でNG条件メモを編集"`

---

## Task 6: 検証
- [ ] Run `pnpm test` → 全 PASS（新規 ztest-therapist-ng 込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: キャスト本人のNG条件（発注者確定）＝Task1-5。登録（管理）と表示（受付/案内表/配車/一覧/担当変更）の両方を満たす。
- 影響範囲: 表示専用。予約可否・金額・占有には一切影響しない（フィールド追加のみ）。
- 型整合: `ngNote` を各返り値へ追加（additive）→ 各 UI が使用。`setTherapistNgNote`/`listTherapistNgNotes`（Task2）を Task5 が使用。
- 注意: 既存テストはフィールド追加で壊れない想定。壊れたら追加分のみ修正する（既存アサーションの意味は変えない）。
