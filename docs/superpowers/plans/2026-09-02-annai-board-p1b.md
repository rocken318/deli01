# 案内表ボード P1b（インライン予約ポップ）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 案内表の行をクリックすると下にインライン予約ポップが開き、その場で予約を作成できる。総額は常時表示（電話で伝える）。**料金計算と予約作成は既存 `feeBreakdown`/`createPhoneOrder` を再利用**（money 経路の再実装ゼロ）。

**Architecture:** 板ページのセラピスト行をクライアントコンポーネント化し、展開状態を持つ。ポップは既存 server actions（`searchCustomerByPhone`/`searchHotels`/`createPhoneOrder`）を呼ぶ。総額は新規 `previewOrderTotal`（server・`feeBreakdown` を再利用）を debounced で呼んで正確に表示。延長は P2 送り（施術後フロー）。交通費は deli01 既存計算（feeBreakdown/settings）をそのまま。

**Tech Stack:** Next.js 15（server component 板＋client ポップ）/ 既存 orders actions / date-fns-tz / Vitest。

設計: `docs/superpowers/specs/2026-09-02-annai-console-design.md`。前提: P1a マージ済（/admin/annai）。

## 再利用する既存資産（確認済み）
- `feeBreakdown`（`src/domain/booking/fees.ts`）: `{ coursePrice, optionPrices, nominationFee, travelInMode, startAt, settings }` → `{ nominationFee, transportFee, totalAmount }`。純関数。
- `createPhoneOrder(data: OrderFormData)`（`orders/actions.ts:327`）: `createHold`（排他/エンジン）→held→confirmed。入力に therapistId/Slug, phone, customerName, courseId, optionIds, hotelId, startAtISO, areaId, destinationType, roomNumber, addressDetail, preferences。
- `searchCustomerByPhone`(actions.ts:57) / `searchHotels`(actions.ts:117・返り: id/name/areaId/areaName/extraMinutes/**entryNote**) / `registerProvisionalHotel`(actions.ts:897)。
- `loadBookingFees`（settings ロード）: previewOrderTotal で再利用。

## File Structure
- Create `src/app/(admin)/admin/orders/preview-actions.ts` — `previewOrderTotal`（server・feeBreakdown 再利用）
- Create `src/app/(admin)/admin/annai/BookingPopup.tsx` — インライン予約ポップ（client）
- Create `src/app/(admin)/admin/annai/BoardRow.tsx` — 行（client・展開状態＋ポップ）
- Modify `src/app/(admin)/admin/annai/page.tsx` — Row を client BoardRow に差し替え、コース/オプション一覧を渡す
- Modify `src/lib/annai/queries.ts` — なし（P1a のまま）
- Create `tests/integration/annai-preview-total.test.ts` — previewOrderTotal の実Postgres検証

---

### Task 1: previewOrderTotal（総額プレビュー・server）

**Files:**
- Create: `src/app/(admin)/admin/orders/preview-actions.ts`
- Test: `tests/integration/annai-preview-total.test.ts`

- [ ] **Step 1: 失敗する統合テスト**

```ts
// tests/integration/annai-preview-total.test.ts
import { describe, expect, it } from "vitest";
import { previewOrderTotal } from "@/app/(admin)/admin/orders/preview-actions";

// getDevSession は ADMIN_DEV_SESSION=1 のとき owner を返す（既存テストと同条件）。
// CI/ローカルとも dev スタブ経路で server action を叩く。
describe("previewOrderTotal (実Postgres)", () => {
  it("コース＋オプションで total が course+option 以上になる", async () => {
    // 実データの course/option を取得して渡す
    const r = await previewOrderTotal({
      courseId: "SEED_COURSE_ID",
      optionIds: [],
      startAtISO: new Date().toISOString(),
      travelInMode: "car",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.totalAmount).toBeGreaterThan(0);
  });
});
```

> 注記: 実装時に SEED_COURSE_ID は `select id from courses order by duration_min limit 1` で解決してから渡すよう書き換える（他統合テスト同様に beforeAll で取得）。`getDevSession` の dev スタブ有効化は既存の `tests` 環境設定に従う（ADMIN_DEV_SESSION）。dev セッション不可な環境では skip 条件を入れる。

- [ ] **Step 2: 落ちる確認** — Run: `pnpm test tests/integration/annai-preview-total.test.ts` → FAIL（未実装）。

- [ ] **Step 3: 実装**

```ts
// src/app/(admin)/admin/orders/preview-actions.ts
"use server";

import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import { feeBreakdown } from "@/domain/booking";
import { loadBookingFees } from "./actions";

export interface PreviewInput {
  courseId: string;
  optionIds: string[];
  startAtISO: string;
  travelInMode: "walk" | "car";
}
export type PreviewResult =
  | { ok: true; data: { nominationFee: number; transportFee: number; totalAmount: number } }
  | { ok: false; error: string };

/** 総額プレビュー（作成しない）。createPhoneOrder と同じ feeBreakdown を使う。 */
export async function previewOrderTotal(input: PreviewInput): Promise<PreviewResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const sql = getClient();
  const courses = await sql<{ price: number; nomination_fee_default: number }[]>`
    select price, nomination_fee_default from courses where id = ${input.courseId}::uuid limit 1
  `;
  const course = courses[0];
  if (!course) return { ok: false, error: "コースが見つかりません" };

  const options = input.optionIds.length
    ? await sql<{ price: number }[]>`select price from options where id = any(${input.optionIds}::uuid[])`
    : [];

  const settings = await loadBookingFees();
  const b = feeBreakdown({
    coursePrice: course.price,
    optionPrices: options.map((o) => o.price),
    nominationFee: course.nomination_fee_default,
    travelInMode: input.travelInMode,
    startAt: new Date(input.startAtISO),
    settings,
  });
  return { ok: true, data: { nominationFee: b.nominationFee, transportFee: b.transportFee, totalAmount: b.totalAmount } };
}
```

> 実装前に `loadBookingFees` が `orders/actions.ts` から export されているか確認。されていなければ export を足す（1行）か、`@/lib/booking` 側の同等ローダを使う。

- [ ] **Step 4: テスト通す** — Run: `pnpm test tests/integration/annai-preview-total.test.ts` → PASS。
- [ ] **Step 5: Commit** — `git add ... && git commit -m "feat(annai): previewOrderTotal (reuse feeBreakdown)"`

---

### Task 2: BookingPopup（client・既存 action を呼ぶ）

**Files:**
- Create: `src/app/(admin)/admin/annai/BookingPopup.tsx`

- [ ] **Step 1: 実装**（要点。完全なJSXは実装時にモック annai-v13/v12 準拠で埋める）

構成:
- props: `{ therapistId, therapistSlug, therapistName, defaultStartISO, courses, options }`。
- state: phone/name（`searchCustomerByPhone` で debounce 補完）、courseId、selectedOptionIds、startISO（既定=defaultStartISO）、hotelQuery/hotelId（`searchHotels`・選択で areaId と entryNote を保持し備考に自動追記）、destinationType、roomNumber、preferences（備考）。
- 総額: courseId/optionIds/startISO 変化で `previewOrderTotal` を debounce 呼び出し→表示（金色・大）。
- 「予約する」: `createPhoneOrder({ therapistId, therapistSlug, phone, customerName, courseId, optionIds, hotelId, areaId, startAtISO, destinationType, roomNumber, addressDetail, preferences })` を呼ぶ。成功→onCreated()（親が板を再取得/該当行更新）。失敗→エラー表示（枠外は理由要求など既存メッセージをそのまま出す）。
- 3状態（idle/sending/error）＋44pxタッチ、spec 12-2 明るいトークン、備考は必須枠（オレンジ）。オプションはチェックボックス（金額つき）。

> 完全実装時: モック `annai-v12/v13`（`.superpowers/brainstorm/.../annai-v12-total.html` 等）の項目・配色に合わせる。延長は含めない（P2 施術後フロー）。

- [ ] **Step 2: 型チェック** — Run: `pnpm typecheck`。
- [ ] **Step 3: Commit**

---

### Task 3: BoardRow（client・行の展開）＋ page 差し替え

**Files:**
- Create: `src/app/(admin)/admin/annai/BoardRow.tsx`
- Modify: `src/app/(admin)/admin/annai/page.tsx`

- [ ] **Step 1: BoardRow を client 化**（P1a の Row をそのまま client に移し、`onClick` で `open` トグル→下に `<BookingPopup>` を条件描画）。名前/予約カードの `<Link>` はクリック伝播を止める（`stopPropagation`）。
- [ ] **Step 2: page.tsx で BoardRow を使う**（active/retired を BoardRow に。courses/options 一覧を server で取得して props で渡す）。
- [ ] **Step 3: build** — Run: `pnpm build` → `/admin/annai` エラーなし。
- [ ] **Step 4: Commit**

---

### Task 4: 検証＋レビュー＋PR

- [ ] **Step 1**: `pnpm typecheck && pnpm lint && TZ=UTC pnpm test && pnpm build`。
- [ ] **Step 2**: reviewer(fable) — createPhoneOrder 呼び出しの入力整合・RLS・total プレビューが作成と一致・any/直書き小数・排他の扱い。
- [ ] **Step 3**: PR → CI 緑 → squash マージ。

---

## Self-Review
- **Spec coverage（P1b）**: インライン予約ポップ(Task2/3)・総額常時表示(Task1)・OPチェック(Task2)・備考＋ホテル入り方自動(Task2)・ホテル→エリア（交通費は feeBreakdown 経由)(Task1/2)・予約作成=createPhoneOrder 再利用(Task2)。**延長は P2 送り**（施術後フロー・設計の非目的に整合）。**交通費は deli01 既存 feeBreakdown をそのまま**（新モデル作らず＝money 再実装ゼロ）。
- **Placeholder**: Task2/3 の JSX は「モック準拠で実装時に埋める」と明示（UIの逐次コードは実装フェーズで確定）。ロジック層（Task1）は完全コード。
- **Type consistency**: `PreviewInput/PreviewResult/previewOrderTotal`、createPhoneOrder の OrderFormData 準拠。
