# 配車表 フェーズ5（予約→配車連携）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 予約に「車の要否」フラグ（送り車／帰り車）を持たせ、**チェックした車だけ配車ボードに載る**ようにする。既定は送り＋帰り両方ON（＝従来どおり全予約が載る）、立町近隣・自力来店は staff がOFFにして外す。送りをONにすると帰りも自動ON（基本ワンセット）。

**Architecture:** `reservations` に `needs_send_car`/`needs_return_car`（既定 true・既存予約は true backfill）を追加。`getDispatchBoardCore` はフラグを**追加返却するだけ**（サーバ側フィルタはしない＝既存テスト非破壊）。配車ボードの**クライアントがフラグで表示を絞る**（送り/帰りセルの出し分け＋「配車不要も表示」トグル）。フラグ更新は `setReservationDispatchNeeds`（staff）。予約詳細に配車ブロック。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。設計 4.6・5.2。参考モック `.superpowers/brainstorm/1464-1789071838/content/reservation-dispatch-link-v2.html`。

---

## 前提
- 最新 = `0033_dispatch_legs.sql` → 本フェーズ **`0034_reservation_car_needs.sql`**。
- 予約作成（`createHold` / `createPhoneOrder`）は**触らない**。新列は DB default=true で入るので新規予約も既定ON。
- therapist 列ガード（0012 `reservations_therapist_guard`）は allow-list 方式＝新列は自動的に therapist から保護される（追加変更不要・0024/0025 と同じ）。
- `getDispatchBoardCore`（`src/lib/dispatch-board/queries.ts`）に select 2列＋`DispatchBoardItem` に 2 フィールド追加（**フィルタは足さない**）。
- 予約詳細ページ = `src/app/(admin)/admin/reservations/[id]/page.tsx`（既存。清算パネル等がある）。

## File Structure
- Create `migrations/0034_reservation_car_needs.sql`
- Modify `src/lib/dispatch-board/queries.ts`（`DispatchBoardItem` に `needsSendCar`/`needsReturnCar`・select 追加）
- Create `src/lib/dispatch-board/needs-actions.ts`（`setReservationDispatchNeeds`）＋ `tests/integration/ztest-reservation-car-needs.test.ts`
- Modify `src/app/(admin)/admin/dispatch-board/DispatchBoardClient.tsx`（フラグで送り/帰りセル出し分け・行フィルタ・配車不要も表示トグル・行内 配車トグル）
- Create `src/app/(admin)/admin/reservations/[id]/DispatchNeeds.tsx`（配車ブロック・連動チェック）＋ 予約詳細 page.tsx に差し込み

---

## Task 1: マイグレーション 0034

**Files:** Create `migrations/0034_reservation_car_needs.sql`

- [ ] **Step 1: 作成**

```sql
-- 0034_reservation_car_needs: 予約の車要否（設計 4.6/5.2）。
-- 既定 true（送り＋帰り両方）。既存予約も true で backfill（従来どおり board に載る）。
-- RLS: 0008 の reservations_staff_all が新列に適用。therapist guard(0012) が自動保護。

alter table reservations
  add column if not exists needs_send_car   bool not null default true,
  add column if not exists needs_return_car bool not null default true;
```

（`add column ... default true` は既存行も true になる＝backfill 兼用。）

- [ ] **Step 2:** Run `pnpm db:migrate` → `適用: 0034_reservation_car_needs.sql`。
- [ ] **Step 3:** `git add migrations/0034_reservation_car_needs.sql && git commit -m "feat(dispatch): 予約に車要否フラグ needs_send_car/needs_return_car を追加"`

---

## Task 2: getDispatchBoardCore にフラグを追加返却

**Files:** Modify `src/lib/dispatch-board/queries.ts`

- [ ] **Step 1: `DispatchBoardItem` に 2 フィールド追加**

`DispatchBoardItem` インターフェース（`dispatchMemo` の直後あたり）に:

```ts
  /** 車要否（0034）。false の車はボードで送り/帰りセルを出さない */
  needsSendCar: boolean;
  needsReturnCar: boolean;
```

`BoardRow` インターフェースにも:

```ts
  needs_send_car: boolean;
  needs_return_car: boolean;
```

- [ ] **Step 2: SQL select に追加**

`getDispatchBoardCore` の select（`r.dispatch_driver, r.dispatch_memo` の行）を:

```ts
        r.dispatch_driver, r.dispatch_memo,
        r.needs_send_car, r.needs_return_car
```

- [ ] **Step 3: map に追加**

返却 map（`dispatchMemo: r.dispatch_memo,` の直後）に:

```ts
      needsSendCar: r.needs_send_car,
      needsReturnCar: r.needs_return_car,
```

- [ ] **Step 4:** Run `pnpm test -- tests/integration/ztest-dispatch-ops.test.ts` → 既存 PASS（フィールド追加のみ・既存アサーション不変）。
- [ ] **Step 5:** `git add src/lib/dispatch-board/queries.ts && git commit -m "feat(dispatch): 配車ボードに車要否フラグを追加返却（additive）"`

---

## Task 3: 車要否の更新アクション ＋ 統合テスト（TDD）

**Files:** Create `src/lib/dispatch-board/needs-actions.ts`, `tests/integration/ztest-reservation-car-needs.test.ts`

仕様: `setReservationDispatchNeeds({ reservationId, needsSendCar, needsReturnCar })`（manage_reservations）。両 false も許容（＝配車不要）。

- [ ] **Step 1: 失敗するテスト**

Create `tests/integration/ztest-reservation-car-needs.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { setReservationDispatchNeeds } from "@/lib/dispatch-board/needs-actions";
import { getDispatchBoardCore } from "@/lib/dispatch-board/queries";
import type { Session } from "@/lib/auth/session";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });
const receptionSession: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000003", role: "reception" };

let aoiId: string, customerId: string, addressId: string, resId: string, resDate: string;
const PHONE = "0906666" + String(Date.now()).slice(-4);

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;
  customerId = (await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE}, '車要否テスト') returning id`)[0]!.id;
  addressId = (await sql<{ id: string }[]>`
    insert into addresses (customer_id, kind, detail, area_id, label)
    values (${customerId}::uuid, 'home', '住所', (select id from areas limit 1), 'ラベル') returning id`)[0]!.id;
  const id = randomUUID();
  const start = new Date(Date.now() + 240 * 60_000);
  await sql`
    insert into reservations (id, therapist_id, customer_id, address_id, area_id, course_id,
      start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min, status, total_amount)
    values (${id}::uuid, ${aoiId}::uuid, ${customerId}::uuid, ${addressId}::uuid,
      (select id from areas limit 1), (select id from courses limit 1),
      ${start}, ${new Date(start.getTime()+3_600_000)}, ${new Date(start.getTime()-1_200_000)},
      ${new Date(start.getTime()+4_800_000)}, 15, 15, 5, 'confirmed'::reservation_status, 10000)`;
  resId = id;
  resDate = formatInTimeZone(start, "Asia/Tokyo", "yyyy-MM-dd");
});

afterAll(async () => {
  await sql`delete from reservations where id = ${resId}::uuid`;
  await sql`delete from addresses where id = ${addressId}::uuid`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("車要否フラグ", () => {
  it("既定は送り/帰り両方 true（board が返す）", async () => {
    const out = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (out.kind !== "ok") throw new Error("forbidden");
    const item = out.items.find((i) => i.reservationId === resId)!;
    expect(item.needsSendCar).toBe(true);
    expect(item.needsReturnCar).toBe(true);
  });

  it("帰りだけ false に更新できる", async () => {
    const r = await setReservationDispatchNeeds({ reservationId: resId, needsSendCar: true, needsReturnCar: false });
    expect(r.ok).toBe(true);
    const out = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (out.kind !== "ok") throw new Error("forbidden");
    const item = out.items.find((i) => i.reservationId === resId)!;
    expect(item.needsSendCar).toBe(true);
    expect(item.needsReturnCar).toBe(false);
  });

  it("両方 false も可（配車不要）", async () => {
    const r = await setReservationDispatchNeeds({ reservationId: resId, needsSendCar: false, needsReturnCar: false });
    expect(r.ok).toBe(true);
    const out = await getDispatchBoardCore(sql, receptionSession, resDate);
    if (out.kind !== "ok") throw new Error("forbidden");
    const item = out.items.find((i) => i.reservationId === resId)!;
    expect(item.needsSendCar).toBe(false);
    expect(item.needsReturnCar).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `pnpm test -- tests/integration/ztest-reservation-car-needs.test.ts` → FAIL（module not found）。

- [ ] **Step 3: 実装**

Create `src/lib/dispatch-board/needs-actions.ts`:

```ts
'use server';

/** 予約の車要否フラグ更新（設計 4.6/5.2）。権限 manage_reservations。 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';

export interface ActionResult<T = void> { ok: boolean; data?: T; error?: string; }

const schema = z.object({
  reservationId: z.string().uuid(),
  needsSendCar: z.boolean(),
  needsReturnCar: z.boolean(),
});

export async function setReservationDispatchNeeds(
  input: z.input<typeof schema>,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };
  const d = parsed.data;
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update reservations
        set needs_send_car = ${d.needsSendCar}, needs_return_car = ${d.needsReturnCar}, updated_at = now()
        where id = ${d.reservationId}::uuid
        returning id`;
    });
    if (rows.length === 0) return { ok: false, error: '予約が見つかりません' };
    revalidatePath('/admin/dispatch-board');
    revalidatePath('/admin/annai');
    revalidatePath(`/admin/reservations/${d.reservationId}`);
    return { ok: true };
  } catch (e) {
    console.error('setReservationDispatchNeeds failed:', e);
    return { ok: false, error: '車要否の更新に失敗しました' };
  }
}
```

- [ ] **Step 4:** Run `pnpm test -- tests/integration/ztest-reservation-car-needs.test.ts` → PASS。
- [ ] **Step 5:** `git add src/lib/dispatch-board/needs-actions.ts tests/integration/ztest-reservation-car-needs.test.ts && git commit -m "feat(dispatch): 車要否フラグ更新アクション＋統合テスト"`

---

## Task 4: 配車ボードがフラグで出し分け

**Files:** Modify `src/app/(admin)/admin/dispatch-board/DispatchBoardClient.tsx`

要件:
- 行の表示は既定で `needsSendCar || needsReturnCar` の予約のみ（＝配車不要は隠す）。上部に **「配車不要も表示」トグル**（ONで全予約）。
- 送り車セルは `needsSendCar` の時だけレンダリング（false は「—」or 空）。帰り車セルは `needsReturnCar` の時だけ。
- 各行に**配車トグル**（小さな「配車」チップ or チェック）: クリックで `setReservationDispatchNeeds` を呼ぶ。**送りON→帰りも自動ON**、両OFFで配車不要（行が隠れる／トグルで戻せる）。実装は簡易でよい（例: 「送り」「帰り」2つの小チェック、送りチェックで帰りも付く）。
- 既存の脚セル（フェーズ4）・状態色・D&D・終了・アラート・時刻は保持。フラグ false の側はセルを出さない。

- [ ] **Step 1:** 上記を実装（フェーズ4の client に条件分岐を追加）。
- [ ] **Step 2:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/dispatch-board/DispatchBoardClient.tsx" && git commit -m "feat(dispatch): 配車ボードを車要否フラグで出し分け＋行内配車トグル"`

---

## Task 5: 予約詳細に配車ブロック

**Files:** Create `src/app/(admin)/admin/reservations/[id]/DispatchNeeds.tsx`; Modify `.../[id]/page.tsx`

参考モック `reservation-dispatch-link-v2.html`。要件:
- 予約詳細ページに「🚗 配車」ブロック（client component `DispatchNeeds`）。現在の `needsSendCar`/`needsReturnCar` を props で受け、**連動チェック**（配車する＝送り＋帰り／送り→帰り自動ON／帰りだけ外す可）。保存で `setReservationDispatchNeeds`。
- page.tsx で予約の `needs_send_car`/`needs_return_car` を取得して渡す（既存の予約取得クエリに 2 列足す or 別 select）。既存表示は壊さない。

- [ ] **Step 1:** `DispatchNeeds.tsx`（client・連動ロジックは `reservation-dispatch-link-v2.html` の JS 準拠）を作成。
- [ ] **Step 2:** page.tsx にフラグ取得＋ブロック差し込み。
- [ ] **Step 3:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 4:** `git add "src/app/(admin)/admin/reservations/[id]" && git commit -m "feat(dispatch): 予約詳細に配車ブロック（送り＋帰り連動チェック）"`

---

## Task 6: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（ztest-reservation-car-needs 込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 設計5.2（車要否・チェックした車だけ載る・送り→帰り既定連動）＝Task1-5。予約作成 engine は触らず DB default=true で新規も既定ON。
- Placeholder: migration/query 変更/action/test は完全コード。UI（Task4/5）は既存 client 拡張＋モック参照＋要件。
- 型整合: `DispatchBoardItem.needsSendCar/needsReturnCar`（Task2）を Task4/test が使用。`setReservationDispatchNeeds`（Task3）を Task4/5 が使用。
- リスク: `getDispatchBoardCore` はフィールド追加のみ（フィルタ無し）＝既存テスト非破壊。フィルタはクライアント。
