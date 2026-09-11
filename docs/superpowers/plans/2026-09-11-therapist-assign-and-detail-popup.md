# セラピスト指定・担当変更＋予約詳細ポップアップ＋OP追加の使い勝手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** (A) **予約の担当セラピストを後から変更**できる（＝今は不可能で現場が詰む）。(B) 受付で**セラピストを明示的に選べる**（案内表ミニの名前クリックで埋まる）。(C) **予約一覧から予約詳細をポップアップ**で見る。(D) **OP追加の失敗理由を具体化**＋**＋OPボタンを押しやすく**。

**Architecture:** 担当変更は `changeReservationTherapist` を新設（同一時間帯で対象セラピストが空いているか `exclusion` に任せ、衝突時は override 可）。指名料は**据え置き**（金額を勝手に変えない・UIに明示）。詳細ポップアップは既存の予約詳細データを読む軽量 action＋モーダル。OP 失敗理由は `addSameDayExtension` のメッセージを具体化。マイグレーション無し。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。

---

## 前提（実装者は該当ファイルを読む）
- `src/lib/booking/extension-actions.ts`: `addSameDayExtension`。`loadOptionSnapshots(sql,{optionIds,therapistId})` が `option_availability`（行があるオプションは対応セラピストのみ）で絞るため、対象外だと `'このオプションは追加できません（対象外）'` になる。**ここを「このセラピストは〈OP名〉に対応していません（オプション管理で対応者を設定）」に具体化**する。
- `reservations.therapist_id`、排他制約 `no_therapist_overlap`（同一セラピストの占有重複を DB が拒否）。`version` で楽観ロック。
- `src/lib/reservations/list-actions.ts`（`getReservationList`）、`src/app/(admin)/admin/reservation-list/ReservationListClient.tsx`（カード・OpAddPanel・RoomNumberInput）。
- 予約詳細ページ: `src/app/(admin)/admin/reservations/[id]/page.tsx`（清算・配車ブロック等）。ポップアップは**このページへ遷移せず**要点を出す。
- 案内表ミニ: 予約一覧 page.tsx は既に `availWindows`（案内表と同じ算出）を持ち「派遣できるセラピスト」パネルを表示済み。受付 `/admin/orders` には未実装（計画 `2026-09-11-orders-annai-mini.md` と統合してよい）。
- `src/app/(admin)/admin/orders/OrderEntryForm.tsx`: `selectedTherapistId/Slug`・`therapistSelectMode` を内部 state で持つ。

## File Structure
- Create `src/lib/reservations/therapist-actions.ts`（`changeReservationTherapist`・`listAssignableTherapists`）＋ `tests/integration/ztest-therapist-change.test.ts`
- Create `src/lib/reservations/detail-actions.ts`（`getReservationDetailLite`）
- Modify `src/lib/booking/extension-actions.ts`（失敗理由の具体化）
- Modify `src/app/(admin)/admin/reservation-list/ReservationListClient.tsx`（担当変更・詳細ポップアップ・OPボタン拡大）
- Modify `src/app/(admin)/admin/orders/{page.tsx,OrderEntryForm.tsx}`＋Create `AnnaiMiniBar.tsx`/`OrdersConsole.tsx`（セラピスト明示欄＋ミニバー）

---

## Task 1: 担当セラピスト変更（TDD・最重要）

**Files:** Create `src/lib/reservations/therapist-actions.ts`, `tests/integration/ztest-therapist-change.test.ts`

仕様（manage_reservations）:
- `listAssignableTherapists(reservationId)`: 在籍(active)セラピスト一覧＋**その予約の時間帯に空いているか**（`reservations` の占有と重なるか）を返す: `{ id, slug, name, busy: boolean }[]`。
- `changeReservationTherapist({ reservationId, therapistId, overrideReason? })`:
  - 対象予約が `held/confirmed/enroute/in_service`（done/cancelled は不可 →「完了/取消済みの予約は担当を変更できません」）。
  - `update reservations set therapist_id=..., version=version+1 where id=... and version=...`。**排他制約（no_therapist_overlap）が重なりを拒否** → 例外 23P01 を捕捉して「変更先のセラピストは同じ時間に別の予約があります」を返す。`overrideReason` があり `can(actor,'override_slot',{kind:'slot_override',reason})` なら…**※exclusion は DB 制約なので override 不可＝正直にその旨を返す**（二重予約は物理的に作らせない）。
  - **指名料は据え置き**（total_amount / nomination_fee を変更しない）。理由は UI に明示。
  - 配車脚（`dispatch_legs.therapist_id`）も同じ予約のものを更新（board の表示を合わせる）。
  - `audit_logs` に before/after を追記。`revalidatePath('/admin/reservation-list','/admin/dispatch-board','/admin/annai')`。
- テスト: 空いている別セラピストへ変更できる／`listAssignableTherapists` が busy を返す／時間が重なる相手へは失敗する／done は失敗する。4〜5ケース（`ztest-dispatch-legs.test.ts` のフィクスチャ手法に倣う）。

- [ ] **Step 1:** 失敗テスト → **Step 2:** 実行(FAIL) → **Step 3:** 実装 → **Step 4:** 緑。
- [ ] **Step 5:** `git add src/lib/reservations/therapist-actions.ts tests/integration/ztest-therapist-change.test.ts && git commit -m "feat(reservation): 担当セラピストの変更（空き確認・重複はDB制約で拒否・指名料据え置き）"`

---

## Task 2: 予約詳細ライト取得（ポップアップ用）

**Files:** Create `src/lib/reservations/detail-actions.ts`

- `getReservationDetailLite(reservationId)`（manage_reservations）→ `{ id, status, therapistName, customerName, customerPhone, courseName, courseDurationMin, startAtISO, endAtISO, departAtISO, areaName, hotelName, roomNumber, entryNote, options:[{name,price}], coursePrice, nominationFee, transportFee, totalAmount, memo }`。
- 既存 `getDispatchBoardCore` の join を参考に。**staff 向けなので電話番号を含めてよい**（spec 7-1）。

- [ ] **Step 1:** 実装＋`pnpm typecheck`。
- [ ] **Step 2:** `git add src/lib/reservations/detail-actions.ts && git commit -m "feat(reservation-list): 予約詳細ライト取得（ポップアップ用）"`

---

## Task 3: OP 追加の失敗理由を具体化

**Files:** Modify `src/lib/booking/extension-actions.ts`

- `loadOptionSnapshots` が空を返した時のメッセージを、**理由が分かる文**に:
  - `option_availability` に当該オプションの行が存在し、かつ対象セラピストが含まれない → 「このセラピストは『〈OP名〉』に対応していません（オプション管理で対応セラピストを設定してください）」
  - オプションが `is_active=false` / `is_public=false` → 「『〈OP名〉』は現在利用できません（オプション管理で有効化してください）」
  - オプション自体が見つからない → 「オプションが見つかりません」
- 実装: 失敗時に `options` と `option_availability` を1回引いて理由を判定するヘルパを同ファイル内に追加。
- [ ] **Step 1:** 実装＋`pnpm typecheck`＋既存 extension テスト緑。
- [ ] **Step 2:** `git add src/lib/booking/extension-actions.ts && git commit -m "fix(reservation): オプション追加の失敗理由を具体的に表示"`

---

## Task 4: 予約一覧カード（担当変更・詳細ポップアップ・OPボタン拡大）

**Files:** Modify `src/app/(admin)/admin/reservation-list/{page.tsx,ReservationListClient.tsx}`

- **担当変更**: カードのセラピスト名の横に「担当変更」ボタン → `listAssignableTherapists(reservationId)` を呼び、**空き/埋まり付きの一覧**から選択 → `changeReservationTherapist`。成功で一覧再取得。失敗（重複）は警告表示。**「指名料は変わりません」注記**を出す。
- **予約詳細ポップアップ**: 行クリック（または「詳細」ボタン）で**モーダル**を開き `getReservationDetailLite` の内容を表示（時刻・コース・OP内訳・金額・派遣先/部屋・顧客/電話・メモ）。モーダル内に「予約詳細ページを開く ↗」リンク（`/admin/reservations/[id]`）と閉じるボタン。Esc/背景クリックで閉じる。
- **＋OP ボタンを押しやすく**: `fontSize 11→13`、`padding 2px 8px→6px 14px`、最小高さ 32px。部屋番号入力・「セラピストへ送る」も同様に拡大（タッチしやすさ）。
- 既存挙動（D&D・ソート・金額内訳・埋込フォーム）は保持。

- [ ] **Step 1:** 実装 → **Step 2:** `pnpm typecheck && pnpm lint && pnpm build`。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/reservation-list" && git commit -m "feat(reservation-list): 担当変更・予約詳細ポップアップ・操作ボタン拡大"`

---

## Task 5: 受付にセラピスト明示欄＋案内表ミニ

**Files:** Create `src/app/(admin)/admin/orders/{AnnaiMiniBar.tsx,OrdersConsole.tsx}`; Modify `src/app/(admin)/admin/orders/{page.tsx,OrderEntryForm.tsx}`; Create `src/lib/annai/mini-actions.ts`

- `getAnnaiMini()`（manage_reservations）＝`listAnnaiBoardCore`＋`buildBoard` の active を「今すぐ行ける順に全員」返す（`{therapistId,slug,name,kind,fromISO,untilISO,gapMin,busyNow,tooShort}`）。予約一覧 page.tsx の `availWindows` 算出と同じ方法で可（共通化してよい）。
- `AnnaiMiniBar`（client）: 横スクロールのチップ（名前・今すぐ/HH:MMから・空きN分・接客中）。クリックで `onPick`。
- `OrderEntryForm` に `externalTherapist?: {id,slug,name}|null` prop を追加＝変化時に `selectedTherapistId/Slug` と `therapistSelectMode='specific'` を設定（**電話番号・会員名の入力は保持**）。さらに**「セラピスト: ◯◯」を目立つ行で常時表示**＋クリア／おまかせ切替。
- `OrdersConsole`（client ラッパ）＝ミニバー＋フォームを束ね、`externalTherapist` state を持つ。`page.tsx` から `getAnnaiMini()` の初期データとフォーム用 props を渡す。
- [ ] **Step 1:** 実装 → **Step 2:** `pnpm typecheck && pnpm lint && pnpm build`＋既存 phone-order テスト緑。
- [ ] **Step 3:** `git add src/lib/annai/mini-actions.ts "src/app/(admin)/admin/orders" && git commit -m "feat(orders): セラピスト明示欄＋案内表ミニ（名前クリックで選択）"`

---

## Task 6: 検証
- [ ] Run `pnpm test` → 全 PASS（新規 ztest-therapist-change 込み・既存非破壊。※`service-history.test.ts` の1件はローカル既存不具合＝無視）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 担当変更＝Task1/4（**現場の必須機能・未実装だった**）／受付のセラピスト明示＋ミニバー＝Task5／詳細ポップアップ＝Task2/4／OP失敗理由＋ボタン拡大＝Task3/4。
- 金銭: 担当変更で**金額は変えない**（指名料据え置き・UI明示）。OP追加は既存 `addSameDayExtension` 経由（金額/時間/衝突は既存規約）。
- 安全: 同一セラピストの二重予約は DB exclusion が最終防御＝override でも作らせない（UI にその旨を出す）。audit_logs に担当変更を記録。
- 型整合: `listAssignableTherapists`/`changeReservationTherapist`（Task1）・`getReservationDetailLite`（Task2）・`getAnnaiMini`/`externalTherapist`（Task5）を各 UI が使用。
