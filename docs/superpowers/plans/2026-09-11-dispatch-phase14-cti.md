# 配車表 フェーズ14（CTI ベンダー非依存：着信ポップ＋プリフィル予約）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 着信 → 電話番号で顧客引き当て → 受付画面に**着信ポップ** → ワンクリックで**電話受付フォームを電話番号/顧客プリフィルで開く** → 予約入力、という CTI の**ソフト一式**を作る。回線→webhook の配線はベンダー依存なので、**模擬着信ボタン**で動作確認できる形にする（実回線は後で webhook を叩くだけ）。

**Architecture:** 既存の `/api/cti/incoming`（webhook・phone→顧客引き当て→`cti_events` 挿入）と `/admin/cti` を活かす。受付画面がポーリングで新着 `cti_events` を拾い**ポップ表示**（SSE でなくポーリングで十分）。`OrderEntryForm` は `?phone=` プリフィル対応。マイグレーション無し（`cti_events` に phone/customer_id/matched_name/handled_by/handled_at/occurred_at が既にある）。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。設計 5章・spec 22章。

---

## 前提（実装者は該当ファイルを読む）
- `src/app/api/cti/incoming/route.ts`: POST `{phone}` → 顧客引き当て → `cti_events` 挿入（`CTI_WEBHOOK_SECRET` 任意）。**そのまま使う**（模擬着信もこの経路を叩く）。
- `src/app/(admin)/admin/cti/page.tsx`: 既存 CTI 画面。ここをポーリング＋ポップ＋模擬着信に作り込む。
- `cti_events`（0019）: id, phone, customer_id, matched_name, handled_by, handled_at, occurred_at。RLS staff。
- `src/app/(admin)/admin/orders/{OrderEntryForm.tsx,page.tsx}`: `?phone=` を受けてフォームの電話番号を初期化＋顧客検索を発火。
- 顧客照合: `searchCustomerByPhone`（orders/actions.ts）。

## File Structure
- Create `src/lib/cti/actions.ts`（`getRecentIncomingCalls`/`markCtiHandled`/`simulateIncoming`）＋ `tests/integration/ztest-cti.test.ts`
- Modify `src/app/(admin)/admin/cti/page.tsx`（＋ `CtiConsoleClient.tsx` を新規）＝ポーリング＋ポップ＋模擬着信
- Modify `src/app/(admin)/admin/orders/{OrderEntryForm.tsx,page.tsx}`（`?phone=` プリフィル）

---

## Task 1: CTI Server Actions ＋ 統合テスト（TDD）

**Files:** Create `src/lib/cti/actions.ts`, `tests/integration/ztest-cti.test.ts`

仕様（manage_reservations = owner/admin/reception）:
- `getRecentIncomingCalls(sinceSeconds=120)`: 直近 sinceSeconds 以内の `cti_events` を新しい順で `{ id, phone, customerId, matchedName, handled, occurredAtISO }[]`（上限20）。
- `markCtiHandled(id)`: `handled_by=session.userId, handled_at=now()` を set-once（既に handled なら no-op 扱いで ok）。
- `simulateIncoming(phone)`: **模擬着信**。`/api/cti/incoming` と同じロジックで顧客引き当て→`cti_events` 挿入（テスト/デモ用。owner/admin/reception のみ）。電話番号は `^0[0-9]{9,10}$`。

- [ ] **Step 1: 失敗テスト** `ztest-cti.test.ts`: simulateIncoming(phone)→getRecentIncomingCalls に出る→markCtiHandled→handled=true。既存顧客の phone なら customerId/matchedName が付く。4〜5ケース。実 Postgres・`vi.mock('next/cache')`。afterAll で作った cti_events/customer を削除。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 実装（`getClient`/`withUser`/`can(manage_reservations)`/Zod）。simulateIncoming は route.ts の引き当てSQLを流用（顧客 select→cti_events insert）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/lib/cti/actions.ts tests/integration/ztest-cti.test.ts && git commit -m "feat(dispatch): CTI 着信取得/対応済み/模擬着信アクション＋統合テスト"`

---

## Task 2: OrderEntryForm の ?phone= プリフィル

**Files:** Modify `src/app/(admin)/admin/orders/{OrderEntryForm.tsx,page.tsx}`

- page.tsx: `searchParams.phone` を受け、`^0[0-9]{9,10}$` に合えば OrderEntryForm へ `initialPhone` prop で渡す。
- OrderEntryForm: `initialPhone?: string` prop を追加。あれば電話番号 state を初期化し、マウント時に既存の顧客検索（`searchCustomerByPhone`）を1回発火して顧客名/住所をプリフィル（既存の検索ロジックを再利用）。既存挙動は不変（prop 無しは従来通り）。

- [ ] **Step 1:** 実装。
- [ ] **Step 2:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。既存 phone-order テスト緑。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/orders" && git commit -m "feat(dispatch): 電話受付フォームを ?phone= でプリフィル（CTIから遷移）"`

---

## Task 3: CTI 受付コンソール（ポーリング＋ポップ＋模擬着信）

**Files:** Modify `src/app/(admin)/admin/cti/page.tsx`; Create `src/app/(admin)/admin/cti/CtiConsoleClient.tsx`

- page.tsx: `getRecentIncomingCalls()` 初期取得→client へ。
- CtiConsoleClient:
  - **数秒ごとにポーリング**（`getRecentIncomingCalls` を 4〜5秒間隔）。新着着信を上に積む。
  - 各着信を**ポップ/行**で表示: 電話番号・引き当て顧客名（既存客/新規）・時刻・「**この番号で予約入力**」ボタン（`/admin/orders?phone=<phone>` へ遷移）・「対応済み」ボタン（`markCtiHandled`）。未対応は強調。
  - **模擬着信**: 電話番号入力＋「模擬着信」ボタン（`simulateIncoming(phone)`）＝回線が無くてもポップの動作確認ができる。
  - 3状態。管理側日本語直書き可・`any` 禁止。
- ナビは既存の「着信」(/admin/cti) を使う（変更不要）。

- [ ] **Step 1:** 実装。
- [ ] **Step 2:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/cti" && git commit -m "feat(dispatch): CTI受付コンソール（着信ポーリング/ポップ/模擬着信→予約入力）"`

---

## Task 4: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（ztest-cti 込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 着信→顧客引き当て→ポップ→プリフィル予約＝Task1-3。回線→webhook 配線のみ外部（模擬着信で代替確認）。既存 route.ts/cti_events を再利用しマイグレーション無し。
- Placeholder: actions/test は具体化。UI は既存 CTI/OrderEntryForm 拡張＋要件明示。
- 型整合: `getRecentIncomingCalls`/`markCtiHandled`/`simulateIncoming`（Task1）を Task3 が使用。`initialPhone`（Task2）を page が供給。
- リスク: /api/cti/incoming は不変（simulateIncoming は同ロジックを action 側に持つ）。OrderEntryForm は prop 追加のみ（既存不変）。
