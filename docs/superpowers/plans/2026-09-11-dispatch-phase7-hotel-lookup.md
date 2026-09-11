# 配車表 フェーズ7（ホテルリスト参照）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 予約中に「このホテル入れる？迎え方は？」を即答できる**ホテルリスト参照ビュー**（検索＋フィルタ＋実績/迎え方/注意/住所/地図）を reception も使える形で追加する。

**Architecture:** hotels の intel 列（0026: entry_note/card_key_required/guest_charge_note/access_note/maps_url/is_blocked/address）はすでに揃う。実績（〇/△/✖）は純関数で導出（TDD）。reception 参照用 `listHotelsLookup`（manage_reservations）を追加し、`/admin/hotel-lookup` 画面を新設。既存の owner/admin CRUD `/admin/hotels` は不変。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。設計 5.4。参考モック `.superpowers/brainstorm/1464-1789071838/content/hotel-list.html`。

---

## 前提
- マイグレーション追加なし（既存 hotels 列で足りる）。
- 既存 `src/lib/hotels/hotel-admin-actions.ts`（`listHotelsAdmin`=manage_cms・`HotelAdminRow` に intel 全列）。reception 参照は RLS `hotels_staff_select` が許可。
- 実績の導出規約（実データ取込 memory 準拠）: `is_blocked=true` → ✖(blocked)／`entry_note` が「△」で始まる → △(caution)／それ以外 → 〇(ok)。
- ナビは `admin-nav-model.ts`「受付・配車」に追加。

## File Structure
- Create `src/domain/hotels/record.ts`（`deriveHotelRecord`）＋ `.test.ts`
- Create `src/lib/hotels/hotel-lookup-actions.ts`（`listHotelsLookup`）＋ `tests/integration/ztest-hotel-lookup.test.ts`
- Create `src/app/(admin)/admin/hotel-lookup/{page.tsx,HotelLookupClient.tsx}`
- Modify `src/app/(admin)/_components/admin-nav-model.ts`（`{ href:"/admin/hotel-lookup", label:"ホテルリスト" }`）

---

## Task 1: 実績導出の純関数（TDD）

**Files:** Create `src/domain/hotels/record.ts`, `.test.ts`

- [ ] **Step 1: 失敗テスト** `src/domain/hotels/record.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveHotelRecord } from "./record";

describe("deriveHotelRecord", () => {
  it("is_blocked=true は blocked(✖)", () => {
    expect(deriveHotelRecord(true, null)).toBe("blocked");
    expect(deriveHotelRecord(true, "△要注意")).toBe("blocked");
  });
  it("entry_note が △ で始まると caution(△)", () => {
    expect(deriveHotelRecord(false, "△要注意 1F外迎え")).toBe("caution");
  });
  it("それ以外は ok(〇)", () => {
    expect(deriveHotelRecord(false, "1F外迎え")).toBe("ok");
    expect(deriveHotelRecord(false, null)).toBe("ok");
  });
});
```

- [ ] **Step 2:** Run `pnpm test -- src/domain/hotels/record.test.ts` → FAIL。
- [ ] **Step 3:** 実装 `src/domain/hotels/record.ts`:

```ts
/** ホテルの派遣実績を intel から導出（設計 5.4）。 */
export type HotelRecord = "ok" | "caution" | "blocked";

export function deriveHotelRecord(
  isBlocked: boolean,
  entryNote: string | null,
): HotelRecord {
  if (isBlocked) return "blocked";
  if (entryNote != null && entryNote.trimStart().startsWith("△")) return "caution";
  return "ok";
}
```

- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/domain/hotels/record.ts src/domain/hotels/record.test.ts && git commit -m "feat(dispatch): ホテル実績(〇/△/✖)の導出（純関数）"`

---

## Task 2: listHotelsLookup ＋ 統合テスト（TDD）

**Files:** Create `src/lib/hotels/hotel-lookup-actions.ts`, `tests/integration/ztest-hotel-lookup.test.ts`

仕様: `listHotelsLookup()`（manage_reservations = reception 以上）→ 参照用に intel と導出 record を返す。書込なし。

- [ ] **Step 1: 失敗テスト** `tests/integration/ztest-hotel-lookup.test.ts`（seed hotels 5件を利用・reception セッションで listHotelsLookup を呼び、name/record/cardKeyRequired 等が返ることを検証。追加投入せず read のみ・afterAll は sql.end のみ）:

```ts
import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
import { listHotelsLookup } from "@/lib/hotels/hotel-lookup-actions";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });
afterAll(async () => { await sql.end({ timeout: 5 }); });

describe("listHotelsLookup", () => {
  it("seed のホテルを参照でき、record が付く", async () => {
    const r = await listHotelsLookup();
    expect(r.ok).toBe(true);
    expect((r.data?.length ?? 0)).toBeGreaterThan(0);
    const any = r.data![0]!;
    expect(["ok","caution","blocked"]).toContain(any.record);
    expect(typeof any.name).toBe("string");
    expect("cardKeyRequired" in any).toBe(true);
  });
});
```

- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 実装 `src/lib/hotels/hotel-lookup-actions.ts`:

```ts
'use server';

/** ホテルリスト参照（設計 5.4）。reception 以上が予約中に即答するための read-only ビュー。 */
import { z } from 'zod';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { deriveHotelRecord, type HotelRecord } from '@/domain/hotels/record';

export interface ActionResult<T = void> { ok: boolean; data?: T; error?: string; }

export interface HotelLookupRow {
  id: string; name: string; areaName: string | null; address: string | null;
  entryNote: string | null; cardKeyRequired: boolean;
  guestChargeNote: string | null; accessNote: string | null;
  mapsUrl: string | null; isBlocked: boolean; record: HotelRecord;
}

export async function listHotelsLookup(): Promise<ActionResult<HotelLookupRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string; name: string; area_name: string | null; address: string | null;
        entry_note: string | null; card_key_required: boolean;
        guest_charge_note: string | null; access_note: string | null;
        maps_url: string | null; is_blocked: boolean;
      }[]>`
        select h.id, h.name, ar.name as area_name, h.address, h.entry_note,
               h.card_key_required, h.guest_charge_note, h.access_note, h.maps_url, h.is_blocked
        from hotels h
        left join areas ar on ar.id = h.area_id
        order by h.name asc`;
    });
    return { ok: true, data: rows.map((r) => ({
      id: r.id, name: r.name, areaName: r.area_name, address: r.address,
      entryNote: r.entry_note, cardKeyRequired: r.card_key_required,
      guestChargeNote: r.guest_charge_note, accessNote: r.access_note,
      mapsUrl: r.maps_url, isBlocked: r.is_blocked,
      record: deriveHotelRecord(r.is_blocked, r.entry_note),
    })) };
  } catch (e) {
    console.error('listHotelsLookup failed:', e);
    return { ok: false, error: 'ホテルリストの取得に失敗しました' };
  }
}
```

- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/lib/hotels/hotel-lookup-actions.ts tests/integration/ztest-hotel-lookup.test.ts && git commit -m "feat(dispatch): ホテルリスト参照アクション listHotelsLookup＋統合テスト"`

---

## Task 3: ホテルリスト画面 ＋ ナビ

**Files:** Create `src/app/(admin)/admin/hotel-lookup/{page.tsx,HotelLookupClient.tsx}`; Modify `admin-nav-model.ts`

参考 `hotel-list.html`。要件:
- page.tsx（`getDevSession`→redirect・`listHotelsLookup` 取得→client）。metadata title 'ホテルリスト'・`dynamic='force-dynamic'`。
- HotelLookupClient（client）: **名前検索**（部分一致・client フィルタ）＋**フィルタチップ**（すべて／実績〇のみ(record==='ok')／△(caution)／✖(blocked)／カードキー要(cardKeyRequired)／ゲストチャージ有(guestChargeNote 非空)）。行: 実績バッジ（〇緑/△橙/✖赤）／ホテル名＋エリア／迎え方・注意タグ（カードキー・チャージ）＋entryNote／住所／地図リンク（mapsUrl があれば「地図 ↗」）。行クリックで詳細（accessNote/guestChargeNote 全文）を展開。空/ローディング/エラーの3状態。管理側日本語直書き可。`any` 禁止。色はモック hotel-list.html 準拠（インライン）。
- ナビ「受付・配車」に `{ href:"/admin/hotel-lookup", label:"ホテルリスト" }` 追加。

- [ ] **Step 1:** page.tsx＋HotelLookupClient.tsx 実装。
- [ ] **Step 2:** ナビ追加。
- [ ] **Step 3:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 4:** `git add "src/app/(admin)/admin/hotel-lookup" "src/app/(admin)/_components/admin-nav-model.ts" && git commit -m "feat(dispatch): ホテルリスト画面（検索/フィルタ/実績・迎え方・注意・地図）＋ナビ"`

---

## Task 4: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（record 単体＋ztest-hotel-lookup 込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 設計5.4（ホテル参照・検索/フィルタ/実績/迎え方/注意/地図）＝Task1-3。既存 CRUD /admin/hotels は不変で、reception 参照は新ビューで提供。
- Placeholder: 純関数/action/test は完全コード。UI は既存 admin パターン＋モック参照＋要件。
- 型整合: `HotelRecord`/`deriveHotelRecord`（Task1）を Task2 が使用。`HotelLookupRow`/`listHotelsLookup`（Task2）を Task3 UI が使用。
- 注意: マイグレーション追加なし。方面フィルタは direction_groups 実装（フェーズ9）後に追加余地（本フェーズはエリア/実績/カードキー/チャージのフィルタ）。
