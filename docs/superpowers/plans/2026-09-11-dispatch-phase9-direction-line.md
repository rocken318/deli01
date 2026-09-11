# 配車表 フェーズ9（方面グループ＋送り/キャッチLINE4種）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** (1) 方面グループ（泉区・松森方面 等）を登録できるマスタと画面を追加。(2) 配車ボードの LINE ボタン（フェーズ4のプレースホルダ）を、**送り/キャッチ × 運転手向け/女性向けの4種テキスト生成→コピー**に差し替える。女性向けは電話番号を出さない。

**Architecture:** `direction_groups` マスタ（0037・`hotels.direction_group_id` も追加）＋CRUD＋登録画面。LINE 4種は純関数（`line-texts.ts`・TDD）で生成し、ボードのクライアントがボタン押下でクリップボードへコピー。生成のみ・自動送信しない（spec 16章）。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。設計 4.5・5.7。参考モック `board-redesign-v6.html`（LINE ボタン）。

---

## 前提
- 最新 = `0036_daily_payouts.sql` → 本フェーズ **`0037_direction_groups.sql`**。
- 既存 `buildDispatchMessage`（`src/domain/dispatch/message.ts`）は CMS テンプレ用（別物）。本フェーズは配車特化の 4種を新規純関数で作る。
- ボード client（`DispatchBoardClient.tsx`）は `DispatchBoardItem`（therapistName/hotelName/roomNumber/areaName/customerPhone/departAtISO/doneAtISO 等）を保持。女性向けは customerPhone を**含めない**。
- CRUD/一覧＋フォーム/ナビは既存パターン（drivers）に倣う。

## File Structure
- Create `migrations/0037_direction_groups.sql`
- Create `src/lib/dispatch-board/direction-actions.ts`（CRUD）＋ `tests/integration/ztest-direction-groups.test.ts`
- Create `src/app/(admin)/admin/direction-groups/{page.tsx,DirectionGroupsClient.tsx}`＋ ナビ追加
- Create `src/domain/dispatch/line-texts.ts`（`buildDispatchLineTexts`）＋ `.test.ts`
- Modify `src/app/(admin)/admin/dispatch-board/DispatchBoardClient.tsx`（LINE ボタンを実コピーへ）

---

## Task 1: マイグレーション 0037

**Files:** Create `migrations/0037_direction_groups.sql`

```sql
-- 0037_direction_groups: 方面グループ（設計 4.5）。運転手向けの方面ラベル。
-- hotels.direction_group_id で紐付け（将来のグルーピング用・nullable）。
-- RLS: 参照 = staff、書込 = owner/admin。

create table if not exists direction_groups (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null default 'cccccccc-0000-4000-9000-000000000001'
                references brands (id) on delete restrict,
  name        text not null,
  sort_order  int not null default 0,
  is_active   bool not null default true,
  created_at  timestamptz not null default now()
);

alter table hotels
  add column if not exists direction_group_id uuid
    references direction_groups (id) on delete set null;

alter table direction_groups enable row level security;
alter table direction_groups force row level security;

drop policy if exists direction_groups_read on direction_groups;
create policy direction_groups_read on direction_groups
  for select using (app_current_role() in ('owner','admin','reception','therapist'));
drop policy if exists direction_groups_write on direction_groups;
create policy direction_groups_write on direction_groups
  for all using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

grant select, insert, update, delete on direction_groups to app_runtime;
```

- [ ] Run `pnpm db:migrate` → 適用。
- [ ] `git add migrations/0037_direction_groups.sql && git commit -m "feat(dispatch): direction_groups（方面グループ）＋hotels.direction_group_id を追加"`

---

## Task 2: 方面グループ CRUD ＋ 統合テスト（TDD）

**Files:** Create `src/lib/dispatch-board/direction-actions.ts`, `tests/integration/ztest-direction-groups.test.ts`

仕様: `listDirectionGroups`（manage_reservations 参照）／`createDirectionGroup`・`updateDirectionGroup`・`deleteDirectionGroup`（manage_cms）。`taxi_companies`/`drivers` の CRUD と同型。

- [ ] **Step 1: 失敗テスト** `ztest-direction-groups.test.ts`（`ztest-dispatch-ops.test.ts` に倣う。create→list→update→delete＋reception は insert 不可の RLS。afterAll で作成分削除）。5〜6 ケース。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 実装 `src/lib/dispatch-board/direction-actions.ts`（drivers/actions.ts の枠。型 `DirectionGroupRow { id; name; sortOrder; isActive }`・list=manage_reservations・write=manage_cms・Zod・revalidatePath('/admin/direction-groups')）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/lib/dispatch-board/direction-actions.ts tests/integration/ztest-direction-groups.test.ts && git commit -m "feat(dispatch): 方面グループ CRUD＋統合テスト"`

---

## Task 3: 方面グループ 登録画面 ＋ ナビ

**Files:** Create `src/app/(admin)/admin/direction-groups/{page.tsx,DirectionGroupsClient.tsx}`; Modify `admin-nav-model.ts`

- 一覧＋追加/編集/削除（`DriversClient` の簡易版・名前＋並び順＋有効）。ナビ「受付・配車」に `{ href:"/admin/direction-groups", label:"方面グループ" }`。管理側日本語直書き可・`any` 禁止。
- [ ] **Step 1:** 実装。
- [ ] **Step 2:** ナビ追加。
- [ ] **Step 3:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 4:** `git add "src/app/(admin)/admin/direction-groups" "src/app/(admin)/_components/admin-nav-model.ts" && git commit -m "feat(dispatch): 方面グループ 登録画面＋ナビ"`

---

## Task 4: 送り/キャッチ LINE 4種の純関数（TDD）

**Files:** Create `src/domain/dispatch/line-texts.ts`, `.test.ts`

- [ ] **Step 1: 失敗テスト** `src/domain/dispatch/line-texts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildDispatchLineTexts } from "./line-texts";

const base = {
  therapistName: "あゆ",
  destination: "伽羅（キャラ）",
  direction: "六丁目・仙台新港",
  departText: "20:00",
  outText: "22:27",
  roomNumber: "302",
  customerPhone: "09012345678",
  meetupPlace: "事務所下",
};

describe("buildDispatchLineTexts", () => {
  it("4種を返す", () => {
    const t = buildDispatchLineTexts(base);
    expect(t.sendDriver).toContain("送り");
    expect(t.sendWoman).toContain("あゆ");
    expect(t.catchDriver).toContain("キャッチ");
    expect(t.catchWoman).toContain("お迎え");
  });
  it("運転手向けは部屋番号・電話を含み、女性向けは電話を含まない", () => {
    const t = buildDispatchLineTexts(base);
    expect(t.sendDriver).toContain("302");
    expect(t.catchDriver).toContain("09012345678");
    expect(t.sendWoman).not.toContain("09012345678");
    expect(t.catchWoman).not.toContain("09012345678");
  });
  it("方面は場所に併記される", () => {
    const t = buildDispatchLineTexts(base);
    expect(t.sendDriver).toContain("六丁目・仙台新港");
  });
  it("欠損値でも落ちない（空で埋める）", () => {
    const t = buildDispatchLineTexts({ therapistName: "りく", destination: "自宅送り:人来田" });
    expect(t.sendDriver).toContain("りく");
    expect(typeof t.catchWoman).toBe("string");
  });
});
```

- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 実装 `src/domain/dispatch/line-texts.ts`:

```ts
/**
 * 配車の送り/キャッチ LINE テキスト4種（設計 5.7）。純関数・生成のみ（自動送信しない）。
 * 女性向けは電話番号を構造的に含めない（customerPhone は運転手向けだけ）。
 */
export interface DispatchLineInput {
  therapistName: string;
  destination: string;              // ホテル名 or 送り先
  direction?: string | null;        // 方面
  departText?: string | null;       // 出発 HH:MM
  outText?: string | null;          // アウト HH:MM
  roomNumber?: string | null;
  entryNote?: string | null;        // 迎え方
  customerPhone?: string | null;    // 運転手向けのみ
  meetupPlace?: string | null;      // 女性向け集合場所（既定「事務所下」）
}
export interface DispatchLineTexts {
  sendDriver: string; sendWoman: string; catchDriver: string; catchWoman: string;
}

function place(i: DispatchLineInput): string {
  return i.direction ? `${i.destination}（${i.direction}）` : i.destination;
}
function line(parts: (string | null | undefined)[]): string {
  return parts.filter((p) => p != null && p !== "").join("\n");
}

export function buildDispatchLineTexts(i: DispatchLineInput): DispatchLineTexts {
  const meet = i.meetupPlace && i.meetupPlace !== "" ? i.meetupPlace : "事務所下";
  const sendDriver = line([
    "●●送り●●",
    "事務所下に着いたら、女性が降りますのでご連絡ください。",
    "",
    i.departText ? `出発 ${i.departText}` : "出発",
    `女性 ${i.therapistName}`,
    `場所 ${place(i)}`,
    i.roomNumber ? `部屋 ${i.roomNumber}` : null,
    i.entryNote ? `迎え ${i.entryNote}` : null,
    i.customerPhone ? `電話 ${i.customerPhone}` : null,
    "お願いします",
  ]);
  const sendWoman = line([
    `【送り】${i.therapistName}さん`,
    i.departText ? `${i.departText} 出発予定です` : "出発のご連絡です",
    `${meet}までお願いします`,
  ]);
  const catchDriver = line([
    "☆☆キャッチ☆☆",
    i.outText ? `アウト ${i.outText}` : "アウト",
    `女性 ${i.therapistName}`,
    `場所 ${place(i)}`,
    i.roomNumber ? `部屋 ${i.roomNumber}` : null,
    i.customerPhone ? `電話 ${i.customerPhone}` : null,
    "お願いします",
  ]);
  const catchWoman = line([
    `【お迎え】${i.therapistName}さん`,
    i.outText ? `アウト ${i.outText} 頃にお迎えです` : "お迎えのご連絡です",
    `${meet}でお待ちください`,
  ]);
  return { sendDriver, sendWoman, catchDriver, catchWoman };
}
```

- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/domain/dispatch/line-texts.ts src/domain/dispatch/line-texts.test.ts && git commit -m "feat(dispatch): 送り/キャッチ LINE 4種の生成（純関数・女性向けは電話なし）"`

---

## Task 5: ボードの LINE ボタンを実コピーへ

**Files:** Modify `src/app/(admin)/admin/dispatch-board/DispatchBoardClient.tsx`

- フェーズ4で「準備中」トーストにしていた送り車セルの 🚕運転手/👩女性 ・帰り車セルの 🚕運転手/👩女性 ボタンを、`buildDispatchLineTexts` の結果をクリップボードへコピーする実装に差し替える。
  - 送り車セル: 🚕→`sendDriver`（customerPhone 込み）・👩→`sendWoman`（電話なし）。
  - 帰り車セル: 🚕→`catchDriver`・👩→`catchWoman`。
  - 入力は各行の DispatchBoardItem から: therapistName・destination=hotelName ?? areaName ?? '—'・direction=areaName（方面 direction_group は将来）・departText=出発表示・outText=OUT表示・roomNumber・customerPhone（運転手向けのみ）。退勤送りセクション（send_home）は destination=destinationText・outText なし・送りのみ。
  - コピーは `navigator.clipboard.writeText(text)` → 既存トースト「コピーしました」。失敗時はエラートースト。
- [ ] **Step 1:** 実装（フェーズ4のボタン onClick を差し替え。他挙動は不変）。
- [ ] **Step 2:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/dispatch-board/DispatchBoardClient.tsx" && git commit -m "feat(dispatch): 配車ボードのLINEボタンを送り/キャッチ4種コピーに"`

---

## Task 6: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（line-texts 単体＋ztest-direction-groups 込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 設計4.5（方面グループ）＝Task1-3、5.7（LINE4種・女性は電話なし）＝Task4-5。方面のボード/ホテルへの本格反映（direction_group_id 割当UI）は将来余地と明記（column は用意）。
- Placeholder: migration/CRUD/純関数/test は完全コード。UI は既存パターン＋モック参照。
- 型整合: `DirectionGroupRow`/CRUD（Task2）を Task3 が使用。`DispatchLineInput`/`DispatchLineTexts`/`buildDispatchLineTexts`（Task4）を Task5 が使用。
- 個人情報: 女性向け LINE は customerPhone を構造的に含めない（純関数で保証・テストで検証）。生成のみ・自動送信しない（spec 16章）。
