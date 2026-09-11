# 配車表 フェーズ13（顧客管理画面）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 顧客管理画面 `/admin/customers` を作る。**電話番号で識別**して顧客情報を登録/編集でき、既存データ（ポイント残高・予約履歴・指名NG・引き継ぎメモ）を1画面に集約する。

**Architecture:** `customers`（0008・phone unique・name/name_kana/note）は既存。検索/登録/編集アクション＋詳細集約アクションを新設し、既存の集約クエリ（points/handover/nomination/reservations）を再利用。マイグレーション無し。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。

---

## 前提（実装者は該当ファイルを読む）
- `customers`: id, phone(unique・`^0[0-9]{9,10}$`), name, name_kana, note, timestamps。フェーズ16で `cached_points`（トリガ維持）等あり。
- 既存流用: `src/app/(admin)/admin/orders/actions.ts` `searchCustomerByPhone`（電話→顧客）／`src/lib/points/queries.ts`（ポイント残高・電話 or 顧客ID）／`src/lib/handover/queries.ts`（引き継ぎメモ）／`src/lib/nomination/actions.ts`（指名NG customer_therapist_ng）。予約履歴は `reservations` を顧客IDで引く。
- RLS: customers は機微（spec 13-3）。staff（owner/admin/reception）read/write。書込は reception も（受付が顧客登録するため）＝`manage_reservations`。
- ナビ: `admin-nav-model.ts`「会計・その他」に `{ href:"/admin/customers", label:"顧客" }`。

## File Structure
- Create `src/lib/customers/actions.ts`（`searchCustomers`/`upsertCustomer`/`getCustomerDetail`）＋ `tests/integration/ztest-customers.test.ts`
- Create `src/app/(admin)/admin/customers/{page.tsx,CustomersClient.tsx}`
- Modify `src/app/(admin)/_components/admin-nav-model.ts`

---

## Task 1: 顧客 Server Actions ＋ 統合テスト（TDD）

**Files:** Create `src/lib/customers/actions.ts`, `tests/integration/ztest-customers.test.ts`

仕様（manage_reservations）:
- `searchCustomers(query)`: query が電話番号なら phone 前方一致、それ以外は name 部分一致。`{ id, phone, name, nameKana }[]`（上限20）。空 query は最近更新順で上限20。
- `upsertCustomer({ id?, phone, name, nameKana?, note? })`: id あれば更新、無ければ phone で新規（phone unique 違反は「同じ電話番号の顧客が既にあります」）。phone 形式は customers_phone_check に合わせ Zod で `^0[0-9]{9,10}$`。
- `getCustomerDetail(customerId)`: `{ profile:{id,phone,name,nameKana,note}, pointsBalance:number, recentReservations:[{id,dateISO,therapistName,courseName,status,total}], ngTherapists:[{therapistId,therapistName}], handoverNotes:[{body,createdAtISO}] }`。ポイント/NG/引き継ぎは既存クエリを再利用（無ければ最小 select を書く）。予約履歴は customer_id で最新10件（therapist 表示名は entity_records published->>'name'）。

- [ ] **Step 1: 失敗テスト** `ztest-customers.test.ts`: upsertCustomer で新規作成→searchCustomers（電話/名前）でヒット→getCustomerDetail で profile と pointsBalance(0) と recentReservations が返る→upsertCustomer で name 更新。afterAll で作成顧客を削除。4〜6ケース。実 Postgres・`vi.mock('next/cache')`。電話は衝突回避で `080` + Date 末尾。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 実装（`getClient`/`withUser`/`can(manage_reservations)`/Zod/`ActionResult`・`revalidatePath('/admin/customers')`）。ポイント残高は既存の points クエリ経由 or `select cached_points`（列があれば）or 0。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/lib/customers/actions.ts tests/integration/ztest-customers.test.ts && git commit -m "feat(dispatch): 顧客の検索/登録/詳細集約アクション＋統合テスト"`

---

## Task 2: 顧客管理 画面 ＋ ナビ

**Files:** Create `src/app/(admin)/admin/customers/{page.tsx,CustomersClient.tsx}`; Modify `admin-nav-model.ts`

- page.tsx: `getDevSession`→redirect。初期は最近の顧客（`searchCustomers('')`）。`dynamic='force-dynamic'`。
- CustomersClient: 左＝**電話番号/名前で検索**＋一覧（新規ボタン）。右＝選択顧客の**詳細**（プロフィール編集フォーム: 電話/名前/カナ/メモ＝`upsertCustomer`／ポイント残高／予約履歴／指名NG／引き継ぎメモ）。3状態。管理側日本語直書き可・`any` 禁止。
- ナビ「会計・その他」に「顧客」追加。

- [ ] **Step 1:** page.tsx＋CustomersClient.tsx＋ナビ。
- [ ] **Step 2:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/customers" "src/app/(admin)/_components/admin-nav-model.ts" && git commit -m "feat(dispatch): 顧客管理画面（電話識別・情報編集・履歴/ポイント/NG/引き継ぎ集約）＋ナビ"`

---

## Task 3: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（ztest-customers 込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 顧客管理（電話識別・情報入力・集約）＝Task1-2。既存の points/handover/nomination クエリを再利用。
- Placeholder: actions/test は具体化。UI は既存 admin パターン＋既存集約クエリ再利用（実装者が該当ファイルを読む）。
- 型整合: `searchCustomers`/`upsertCustomer`/`getCustomerDetail`（Task1）を Task2 UI が使用。
- 機微情報: customers は staff のみ（RLS）。電話 unique 違反は日本語文言へ変換。
