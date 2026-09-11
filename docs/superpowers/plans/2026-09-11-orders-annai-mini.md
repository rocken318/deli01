# 受付の案内表ミニ＋セラピスト欄連動 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 電話を受けた瞬間に「今すぐ行ける子」が見えて、名前をクリックするだけでセラピストが決まる導線を作る。(1) **電話受付の上に案内表ミニ**（今すぐ行ける順に全員）。(2) **名前クリックでセラピスト欄が埋まる**（電話番号・会員名は保持）。(3) **セラピスト欄を明示**して各受付画面で選べるようにする。

**Architecture:** 案内表と同じ算出（`listAnnaiBoardCore` ＋ `buildBoard`/`computeAvailableWindow`）を薄い Server Action で公開し、受付ページ上部の client コンポーネント `AnnaiMiniBar` が表示。クリックで `OrderEntryForm` の `selectedTherapistId/Slug` を外から設定（`selectedTherapistId` prop 化 or コールバック）。予約一覧の埋め込みフォームにも同じミニバーを載せる。マイグレーション無し。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Vitest。発注者確定: **今すぐ行ける順に全員**。

---

## 前提（実装者は該当ファイルを読む）
- 案内表の算出: `src/lib/annai/queries.ts` `listAnnaiBoardCore(tx, nowMs)` → `BoardInput[]`／`src/domain/annai/window.ts` `buildBoard(rows, nowMs, buffers, minBookableMin)` → `{active, retired}`（各 `BoardRow.window`: kind `now|from`, `fromMs`, `untilMs`, `gapMin`, `busyNow`, `tooShort`）。使い方は `src/app/(admin)/admin/annai/page.tsx` を参照（`minBookableMin` の組み立ても）。
- 受付: `src/app/(admin)/admin/orders/{page.tsx,OrderEntryForm.tsx}`。フォームは `therapists/courses/options/areas/initialPhone` を props で受け、内部 state に `therapistSelectMode('any'|'specific')`, `selectedTherapistId`, `selectedTherapistSlug`, `phone`, `customerName` を持つ。
- 予約一覧: `src/app/(admin)/admin/reservation-list/{page.tsx,ReservationListClient.tsx}`（OrderEntryForm を埋め込み済み）。
- 案内表ポップ: `src/app/(admin)/admin/annai/BookingPopup.tsx`（こちらは行＝セラピスト固定なので対象外）。

## File Structure
- Create `src/lib/annai/mini-actions.ts`（`getAnnaiMini()`）
- Create `src/app/(admin)/admin/orders/AnnaiMiniBar.tsx`（client・表示＋クリック）
- Modify `src/app/(admin)/admin/orders/{page.tsx,OrderEntryForm.tsx}`
- Modify `src/app/(admin)/admin/reservation-list/{page.tsx,ReservationListClient.tsx}`（同じミニバーを載せる）

---

## Task 1: 案内表ミニの取得アクション

**Files:** Create `src/lib/annai/mini-actions.ts`

仕様（manage_reservations）:
- `getAnnaiMini()` → `{ therapistId, slug, name, kind: 'now'|'from', fromISO: string|null, untilISO: string|null, gapMin: number|null, busyNow: boolean, tooShort: boolean, attendanceState: 'off'|'working'|'done' }[]`。
- 中身は `withUser` の中で `listAnnaiBoardCore(tx, nowMs)` → `buildBoard(...)` の **active** を早い順のまま返す（retired=上がりは除外）。`minBookableMin` は annai/page.tsx と同じ計算（最短コース＋前5分＋上がり＋移動）。失敗時は `ActionResult` のエラー。
- 'use server'。`any` 禁止。

- [ ] **Step 1:** 実装（annai/page.tsx の取得部分を参考に、courses の最短 duration も取る）。
- [ ] **Step 2:** `pnpm typecheck` 通過。
- [ ] **Step 3:** `git add src/lib/annai/mini-actions.ts && git commit -m "feat(orders): 案内表ミニの取得アクション（今すぐ行ける順）"`

---

## Task 2: AnnaiMiniBar（表示＋クリックでセラピスト選択）

**Files:** Create `src/app/(admin)/admin/orders/AnnaiMiniBar.tsx`

要件:
- props: `{ items: AnnaiMiniItem[]; onPick: (t: { id: string; slug: string; name: string }) => void; loading?: boolean }`。
- 横スクロールのチップ列（1人=1チップ）。**今すぐ行ける順**（アクションの順をそのまま）。チップ内容:
  - 名前（大きめ）
  - **今すぐ** or **HH:MM から**（`kind`/`fromISO`・Asia/Tokyo 表示）
  - 空きN分（`tooShort` なら赤字＋「短め」）
  - 接客中は灰色＋「接客中」（`busyNow`）
- チップクリック → `onPick`。選択中は枠を強調。
- 「更新」ボタンで再取得（呼び出し側が `getAnnaiMini` を再実行）。空/ローディング/エラーの3状態。
- 管理側日本語直書き可。`any` 禁止。色は spec 12-2（明色・主色 #3F7A6B）。

- [ ] **Step 1:** 実装。
- [ ] **Step 2:** `pnpm typecheck && pnpm lint` 通過。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/orders/AnnaiMiniBar.tsx" && git commit -m "feat(orders): 案内表ミニバー（今すぐ行ける子のチップ表示）"`

---

## Task 3: 受付フォームにセラピスト欄＋ミニバー連動

**Files:** Modify `src/app/(admin)/admin/orders/{page.tsx,OrderEntryForm.tsx}`

要件:
- **OrderEntryForm に明示的な「セラピスト」欄**を出す（今は指名/おまかせ＋候補検索に埋もれている）: 現在の選択を「セラピスト: ◯◯（指名）」のように**目立つ行**で表示し、クリアボタンと「おまかせに切替」を置く。未選択なら「未選択」。
- **外部から選択できるようにする**: `OrderEntryForm` に `externalTherapist?: { id: string; slug: string; name: string } | null` prop を追加し、変化したら `selectedTherapistId/Slug` と `therapistSelectMode='specific'` を設定する（`useEffect`）。**電話番号・会員名などの入力済み state は保持**（触らない）。
- page.tsx（受付）: サーバで `getAnnaiMini()` を取得 → client ラッパで `AnnaiMiniBar` をフォーム上部に表示し、`onPick` で `externalTherapist` を更新して `OrderEntryForm` に渡す。※ page は server component なので、ミニバー＋フォームを束ねる小さな client ラッパ（例 `OrdersConsole.tsx`）を作り、その中で state を持つ。
- 既存挙動（候補検索・枠選択・作成・車要否・?phone= プリフィル）は不変。

- [ ] **Step 1:** OrderEntryForm に `externalTherapist` prop ＋ セラピスト欄表示を追加。
- [ ] **Step 2:** `OrdersConsole.tsx`（client ラッパ）＋ page.tsx 配線。
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm build` 通過。既存 phone-order テスト緑。
- [ ] **Step 4:** `git add "src/app/(admin)/admin/orders" && git commit -m "feat(orders): 受付にセラピスト欄＋案内表ミニ連動（名前クリックで選択）"`

---

## Task 4: 予約一覧の埋め込みフォームにも同じミニバー

**Files:** Modify `src/app/(admin)/admin/reservation-list/{page.tsx,ReservationListClient.tsx}`

- 予約一覧の「新規予約」セクション（OrderEntryForm 埋め込み）にも `AnnaiMiniBar` を表示し、同様に `externalTherapist` を渡す。page.tsx で `getAnnaiMini()` を取得して client へ。
- 既存挙動（カード編集・D&D・ソート）は不変。

- [ ] **Step 1:** 実装。
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm build` 通過。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/reservation-list" && git commit -m "feat(reservation-list): 新規予約にも案内表ミニを表示"`

---

## Task 5: 検証
- [ ] Run `pnpm test` → 全 PASS（既存非破壊。※`service-history.test.ts` の1件はローカル既存不具合＝無視）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 案内表ミニ（今すぐ行ける順に全員）＝Task1-2、名前クリックでセラピスト欄が埋まる＋セラピスト欄の明示＝Task3、各受付画面（受付・予約一覧）＝Task3-4。
- Placeholder: 既存 annai 算出を再利用（新ロジックを作らない）。UI は要件明示。
- 型整合: `getAnnaiMini`/`AnnaiMiniItem`（Task1）を Task2-4 が使用。`externalTherapist`（Task3）を Task3-4 の呼び出し側が渡す。
- リスク: OrderEntryForm は prop 追加のみ（既存挙動不変・電話/会員名 state は触らない）。createHold/createPhoneOrder は不変。
