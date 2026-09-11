# 予約一覧カードの直接編集（オプション追加・部屋番号・セラピスト連絡）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 予約一覧の**各カードそのもの**から (A) **オプションを選んで追加**でき、**金額（と施術時間）の変化がその場で分かる**。(B) **部屋番号を後から入力**でき、**セラピストへコピペで送れるテキスト**を生成する。

**Architecture:** オプション追加は既存 `addSameDayExtension(reservationId, optionId, {overrideReason})`（オプション追加＝金額加算＋施術時間延長＋`canExtend` 判定、後続予約と衝突なら `overrideReason` で強行可）を**そのまま再利用**。部屋番号は既存 `updateDispatchFields` 相当ではなく `reservations.room_number`（0025）を更新する薄い action を追加。コピペ文は既存 `buildDispatchLineTexts`／`getBookingShareTexts` の思想で「部屋番号入り・セラピスト向け（電話番号なし）」を生成。マイグレーション無し。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。発注者確定: **OP追加は時間も伸ばす**／衝突時は**警告→確認で通す**。

---

## 前提（実装者は該当ファイルを読む）
- `src/lib/booking/extension-actions.ts`: `addSameDayExtension(reservationId, optionId, opts?: {overrideReason})` → `ActionResult<ExtensionResult{ newFreeAt/addedAmount など }>`。`EXTENDABLE_STATUS=['confirmed','enroute','in_service']`。後続と衝突時は ok:false（理由付き）→ `overrideReason` 指定で強行。
- `src/domain/booking/extension.ts` `canExtend`。
- `src/lib/reservations/list-actions.ts`: `getReservationList(dateISO)` → `ReservationListItem`（既に `coursePrice/nominationFee/transportFee/totalAmount/options[]` を持つ＝フェーズ17）。`roomNumber` は**まだ無いので追加**する。
- `src/app/(admin)/admin/reservation-list/ReservationListClient.tsx`（カード/行 UI・D&D・ソート）。
- オプション一覧: `src/lib/options/actions.ts` `listOptionsAdmin()`（フェーズ17）。セラピスト対応の絞り込みが要るなら `src/domain/annai/options.ts` の `filterOptionsForTherapist` を参照。
- 部屋番号: `reservations.room_number`（0025）。配車ボードが `roomNumber` を表示している（`src/lib/dispatch-board/queries.ts`）。
- コピペ文: `src/domain/dispatch/line-texts.ts` `buildDispatchLineTexts`（女性向けは電話番号を含めない）。

---

## Task 1: 予約一覧に roomNumber を返す ＋ 部屋番号更新アクション（TDD）

**Files:** Modify `src/lib/reservations/list-actions.ts`; Create `src/lib/reservations/room-actions.ts`; Modify `tests/integration/ztest-reservation-list.test.ts`

- `ReservationListItem` に `roomNumber: string | null` を追加し、select に `r.room_number` を追加。
- `setReservationRoomNumber({ reservationId, roomNumber })`（manage_reservations・`room_number` を更新、空文字は null 化、max 50字）。`revalidatePath('/admin/reservation-list')` ＋ `/admin/dispatch-board`。
- テスト: 予約を作る→`setReservationRoomNumber` で "302" → `getReservationList` の該当 item の `roomNumber === '302'`。1〜2ケース追加。

- [ ] **Step 1:** テスト追記（失敗確認）。
- [ ] **Step 2:** list-actions に roomNumber 追加＋room-actions 実装 → テスト緑。
- [ ] **Step 3:** `git add src/lib/reservations tests/integration/ztest-reservation-list.test.ts && git commit -m "feat(reservation-list): 部屋番号の取得/更新（カードから後入力）"`

---

## Task 2: セラピスト連絡テキスト（部屋番号入り）

**Files:** Create `src/domain/reservation/therapist-notice.ts` ＋ `.test.ts`

- 純関数 `buildTherapistNotice(input)` → セラピストへコピペで送る文面。
  入力: `{ therapistName, startText, courseName, courseDurationMin, destination(ホテル名 or エリア), roomNumber, entryNote?, optionNames?: string[], totalAmount }`。
  出力例（複数行）:
  ```
  【ご案内】ゆな さん
  15:00 スタンダード 90分
  場所 仙台グランドタワーホテル
  部屋 302
  OP キス / トリップ
  合計 ¥27,000
  ```
- **電話番号は含めない**（セラピスト向け・spec 7-3）。未設定値は行ごと省略（落ちない）。
- テスト: 部屋番号あり/なし・OPあり/なし・電話番号が含まれないこと。4ケース。

- [ ] **Step 1:** 失敗テスト → 実装 → 緑。
- [ ] **Step 2:** `git add src/domain/reservation && git commit -m "feat(reservation-list): セラピスト連絡文の生成（部屋番号入り・電話なし）"`

---

## Task 3: カード UI（オプション追加・部屋番号・コピー）

**Files:** Modify `src/app/(admin)/admin/reservation-list/{page.tsx,ReservationListClient.tsx}`

- page.tsx: `listOptionsAdmin()`（有効なオプション）を取得して client に渡す。
- ReservationListClient の**各カード**に:
  1. **オプション追加**: 「＋OP」ボタン → その場でオプション選択（チェック/セレクト）→ `addSameDayExtension(reservationId, optionId)` を呼ぶ。
     - 成功: 一覧を再取得し、**合計金額・OP一覧・OUT時刻が更新**される（時間も伸びる）。
     - 失敗（後続と衝突）: **警告を出し「それでも追加」**を押したら `overrideReason` を付けて再実行（発注者確定の override）。
     - 対象状態: confirmed/enroute/in_service のみボタン活性（done/cancelled は非活性）。
  2. **部屋番号**: インライン入力（既存値表示・保存で `setReservationRoomNumber`）。
  3. **セラピストへ送る**: `buildTherapistNotice` の結果を `navigator.clipboard.writeText` でコピー（既存トースト）。部屋番号が空なら「部屋番号未入力」を警告しつつコピーは可能。
- 既存挙動（D&D手動順・IN/OUTソート・金額内訳表示・埋め込み受付フォーム）は保持。`any` 禁止・管理側日本語直書き可・金額は整数。

- [ ] **Step 1:** page.tsx でオプション取得＋props 追加。
- [ ] **Step 2:** カードUI（OP追加/override・部屋番号・コピー）を実装。
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 4:** `git add "src/app/(admin)/admin/reservation-list" && git commit -m "feat(reservation-list): カードからOP追加(金額/時間反映)・部屋番号入力・セラピスト連絡コピー"`

---

## Task 4: 検証
- [ ] Run `pnpm test` → 全 PASS（ztest-reservation-list 更新＋therapist-notice 単体込み・既存非破壊。**extension 系テストが緑のまま**であること）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: カードからOP追加（金額＋時間・発注者確定）＝Task1/3、部屋番号後入力＝Task1/3、セラピストへコピペ＝Task2/3。
- Placeholder: 既存 `addSameDayExtension` を再利用（新たな金額ロジックを作らない＝二重実装回避）。純関数/テスト具体化。
- 型整合: `ReservationListItem.roomNumber`／`setReservationRoomNumber`／`buildTherapistNotice` を UI が使用。`addSameDayExtension` は既存シグネチャのまま。
- 金銭/占有: 金額と free_at の更新は既存 action（台帳規約・exclusion 制約準拠）に委譲。override は既存の `overrideReason` 経路のみ（DB の二重予約防止は維持）。
