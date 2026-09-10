# 配車表 フェーズ2（ドライバー/車両 登録）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** ドライバー（人＋車両＋色）を登録・編集できる `drivers` マスタと登録画面（左一覧＋右フォーム・色パレット）を作る。週次シフトはフェーズ3、配車ボードへの D&D 割当はフェーズ4。

**Architecture:** `drivers` テーブル（手書き SQL マイグレーション 0031）＋ Server Actions（`taxi_companies` と同じ CRUD パターン）＋ 統合テスト（実 Postgres・RLS）＋ 登録画面 `/admin/drivers`（左一覧＋右フォーム）。ナビに「ドライバー登録」を追加。

**Tech Stack:** Next.js 15 App Router / TS strict / postgres.js 生 SQL / RLS（`app_current_role()`）/ Zod / Vitest（統合は実 Postgres）。設計書 `docs/superpowers/specs/2026-09-11-dispatch-board-rebuild-design.md`（4.2）。UI 参考モック `.superpowers/brainstorm/1464-1789071838/content/reg-drivers-v6.html`（**週次シフト部分は除く**＝本フェーズ対象外）。

---

## 前提

- 現行最新マイグレーション = `0030_brands.sql` → 本フェーズは **`0031_drivers.sql`**。
- 既定ブランド固定 UUID = `cccccccc-0000-4000-9000-000000000001`（0030 で投入済み）。`drivers.brand_id` の default に使う。
- Server Action 手本: `src/lib/dispatch-roster/actions.ts`（`getDevSession`→`can(toActor(session),'manage_cms')`→`getClient()`→`withUser`→`ActionResult`・Zod・`revalidatePath`）。
- 統合テスト手本: `tests/integration/ztest-dispatch-ops.test.ts`。seed 固定 UUID: owner=`aaaaaaaa-0000-4000-8000-000000000001`、reception=`aaaaaaaa-0000-4000-8000-000000000003`。owner セッションは `createDriver` 等の action が `getDevSession()`（ADMIN_DEV_SESSION=1 → owner）で通る。RLS 直検証は `withUser(sql, {userId, role}, ...)`。
- 管理側 日本語直書き可。`any` 禁止。DB 準備（済のはず）: `pnpm db:up` → `pnpm db:migrate`。
- 登録UI は `DispatchRosterClient.tsx` の state パターン（useState/useTransition・openCreate/openEdit/handleSubmit）に倣う。

## File Structure
- Create `migrations/0031_drivers.sql`
- Create `src/lib/drivers/actions.ts`
- Create `tests/integration/ztest-drivers.test.ts`
- Create `src/app/(admin)/admin/drivers/page.tsx`
- Create `src/app/(admin)/admin/drivers/DriversClient.tsx`
- Modify `src/app/(admin)/_components/admin-nav-model.ts`（「受付・配車」グループに `{ href: "/admin/drivers", label: "ドライバー登録" }` を追加）
- Modify `src/app/(admin)/_components/admin-nav-model.test.ts`（href 一意テストは既存のまま通る。主要グループ4件テストも不変）

---

## Task 1: drivers マイグレーション

**Files:** Create `migrations/0031_drivers.sql`

- [ ] **Step 1: 作成**

```sql
-- 0031_drivers: ドライバー（人＋車両＋識別色）マスタ（設計 4.2）。
-- 1ドライバー=1車を既定。vehicle_color_hex が配車ボードの識別色。
-- RLS: 参照 = owner/admin/reception（配車で使う）、書込 = owner/admin。

create table if not exists drivers (
  id                 uuid primary key default gen_random_uuid(),
  brand_id           uuid not null default 'cccccccc-0000-4000-9000-000000000001'
                       references brands (id) on delete restrict,
  name               text not null,
  phone              text,
  ng_note            text,
  vehicle_number     text,
  vehicle_model      text,
  vehicle_color_hex  text,
  vehicle_color_name text,
  vehicle_note       text,
  sort_order         int not null default 0,
  is_active          bool not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint drivers_color_hex_check check (
    vehicle_color_hex is null or vehicle_color_hex ~ '^#[0-9A-Fa-f]{6}$'
  )
);

create index if not exists drivers_active_idx on drivers (is_active, sort_order);

drop trigger if exists drivers_set_updated_at on drivers;
create trigger drivers_set_updated_at
  before update on drivers
  for each row execute function set_updated_at();

alter table drivers enable row level security;
alter table drivers force row level security;

drop policy if exists drivers_read on drivers;
create policy drivers_read on drivers
  for select
  using (app_current_role() in ('owner','admin','reception'));

drop policy if exists drivers_write on drivers;
create policy drivers_write on drivers
  for all
  using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

grant select, insert, update, delete on drivers to app_runtime;
```

（`set_updated_at()` は既存関数。0016 等で `create trigger ... execute function set_updated_at()` を使用済みなので存在する。）

- [ ] **Step 2: 適用**

Run: `pnpm db:migrate`
Expected: `適用: 0031_drivers.sql`。

- [ ] **Step 3: コミット**

```bash
git add migrations/0031_drivers.sql
git commit -m "feat(dispatch): drivers（ドライバー/車両/識別色）マスタを追加"
```

---

## Task 2: drivers Server Actions ＋ 統合テスト（TDD）

**Files:** Create `src/lib/drivers/actions.ts`, `tests/integration/ztest-drivers.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `tests/integration/ztest-drivers.test.ts`:

```ts
import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  listDrivers,
  createDriver,
  updateDriver,
  deleteDriver,
} from "@/lib/drivers/actions";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

const ids: string[] = [];

afterAll(async () => {
  if (ids.length > 0) await sql`delete from drivers where id = any(${ids}::uuid[])`;
  await sql.end({ timeout: 5 });
});

describe("drivers CRUD（owner session = ADMIN_DEV_SESSION）", () => {
  it("作成できる（色hex含む）", async () => {
    const r = await createDriver({
      name: "畑山",
      phone: "08055580414",
      ngNote: "土曜固定。",
      vehicleNumber: "6417",
      vehicleModel: "ステップワゴン",
      vehicleColorHex: "#2B2B2B",
      vehicleColorName: "黒",
      vehicleNote: "自動ドア",
      sortOrder: 1,
      isActive: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    ids.push(r.data!.id);
  });

  it("一覧に出る", async () => {
    const r = await listDrivers();
    expect(r.ok).toBe(true);
    const found = r.data?.find((d) => d.name === "畑山");
    expect(found?.vehicleColorHex).toBe("#2B2B2B");
    expect(found?.vehicleColorName).toBe("黒");
  });

  it("不正な色hexは拒否", async () => {
    const r = await createDriver({ name: "X", vehicleColorHex: "black" });
    expect(r.ok).toBe(false);
  });

  it("更新できる", async () => {
    const r = await updateDriver({ id: ids[0]!, vehicleColorName: "つや黒", isActive: false });
    expect(r.ok).toBe(true);
    const list = await listDrivers();
    const found = list.data?.find((d) => d.id === ids[0]);
    expect(found?.vehicleColorName).toBe("つや黒");
    expect(found?.isActive).toBe(false);
  });

  it("削除できる", async () => {
    const id = ids.pop()!;
    const r = await deleteDriver(id);
    expect(r.ok).toBe(true);
    const list = await listDrivers();
    expect(list.data?.find((d) => d.id === id)).toBeUndefined();
  });
});

describe("drivers RLS", () => {
  it("reception は drivers を INSERT できない", async () => {
    await expect(
      withUser(sql, receptionSession, async (tx) => {
        return tx`insert into drivers (name) values ('X') returning id`;
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `pnpm test -- tests/integration/ztest-drivers.test.ts`
Expected: FAIL（`Cannot find module '@/lib/drivers/actions'`）。（`-- <path>` が効かなければ `pnpm vitest run tests/integration/ztest-drivers.test.ts`。）

- [ ] **Step 3: actions を実装**

Create `src/lib/drivers/actions.ts`（`dispatch-roster/actions.ts` に倣う。list=manage_reservations、write=manage_cms）:

```ts
'use server';

/**
 * ドライバー登録 Server Actions（設計 4.2）。
 * list = manage_reservations（配車で参照）、write = manage_cms（owner/admin）。
 * 管理側 日本語直書き可。any 禁止。金額は扱わない。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface DriverRow {
  id: string;
  name: string;
  phone: string | null;
  ngNote: string | null;
  vehicleNumber: string | null;
  vehicleModel: string | null;
  vehicleColorHex: string | null;
  vehicleColorName: string | null;
  vehicleNote: string | null;
  sortOrder: number;
  isActive: boolean;
}

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, '色は #RRGGBB 形式で指定してください');

const createSchema = z.object({
  name: z.string().min(1, '氏名は必須です').max(100),
  phone: z.string().max(50).optional(),
  ngNote: z.string().max(1000).optional(),
  vehicleNumber: z.string().max(50).optional(),
  vehicleModel: z.string().max(100).optional(),
  vehicleColorHex: hex.optional(),
  vehicleColorName: z.string().max(50).optional(),
  vehicleNote: z.string().max(1000).optional(),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  phone: z.string().max(50).nullable().optional(),
  ngNote: z.string().max(1000).nullable().optional(),
  vehicleNumber: z.string().max(50).nullable().optional(),
  vehicleModel: z.string().max(100).nullable().optional(),
  vehicleColorHex: hex.nullable().optional(),
  vehicleColorName: z.string().max(50).nullable().optional(),
  vehicleNote: z.string().max(1000).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export async function listDrivers(): Promise<ActionResult<DriverRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string; name: string; phone: string | null; ng_note: string | null;
        vehicle_number: string | null; vehicle_model: string | null;
        vehicle_color_hex: string | null; vehicle_color_name: string | null;
        vehicle_note: string | null; sort_order: number; is_active: boolean;
      }[]>`
        select id, name, phone, ng_note, vehicle_number, vehicle_model,
               vehicle_color_hex, vehicle_color_name, vehicle_note, sort_order, is_active
        from drivers
        order by sort_order asc, name asc
      `;
    });
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id, name: r.name, phone: r.phone, ngNote: r.ng_note,
        vehicleNumber: r.vehicle_number, vehicleModel: r.vehicle_model,
        vehicleColorHex: r.vehicle_color_hex, vehicleColorName: r.vehicle_color_name,
        vehicleNote: r.vehicle_note, sortOrder: r.sort_order, isActive: r.is_active,
      })),
    };
  } catch (e) {
    console.error('listDrivers failed:', e);
    return { ok: false, error: 'ドライバー一覧の取得に失敗しました' };
  }
}

export async function createDriver(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) {
    return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  }
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }
  const d = parsed.data;
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        insert into drivers (
          name, phone, ng_note, vehicle_number, vehicle_model,
          vehicle_color_hex, vehicle_color_name, vehicle_note, sort_order, is_active
        ) values (
          ${d.name}, ${d.phone ?? null}, ${d.ngNote ?? null},
          ${d.vehicleNumber ?? null}, ${d.vehicleModel ?? null},
          ${d.vehicleColorHex ?? null}, ${d.vehicleColorName ?? null},
          ${d.vehicleNote ?? null}, ${d.sortOrder}, ${d.isActive}
        )
        returning id
      `;
    });
    const id = rows[0]?.id;
    if (!id) return { ok: false, error: '登録に失敗しました' };
    revalidatePath('/admin/drivers');
    return { ok: true, data: { id } };
  } catch (e) {
    console.error('createDriver failed:', e);
    return { ok: false, error: 'ドライバーの登録に失敗しました' };
  }
}

export async function updateDriver(
  input: z.input<typeof updateSchema>,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) {
    return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  }
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }
  const d = parsed.data;
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update drivers set
          name               = coalesce(${d.name ?? null}, name),
          phone              = ${d.phone !== undefined ? d.phone : sql`phone`},
          ng_note            = ${d.ngNote !== undefined ? d.ngNote : sql`ng_note`},
          vehicle_number     = ${d.vehicleNumber !== undefined ? d.vehicleNumber : sql`vehicle_number`},
          vehicle_model      = ${d.vehicleModel !== undefined ? d.vehicleModel : sql`vehicle_model`},
          vehicle_color_hex  = ${d.vehicleColorHex !== undefined ? d.vehicleColorHex : sql`vehicle_color_hex`},
          vehicle_color_name = ${d.vehicleColorName !== undefined ? d.vehicleColorName : sql`vehicle_color_name`},
          vehicle_note       = ${d.vehicleNote !== undefined ? d.vehicleNote : sql`vehicle_note`},
          sort_order         = coalesce(${d.sortOrder ?? null}, sort_order),
          is_active          = coalesce(${d.isActive ?? null}, is_active)
        where id = ${d.id}::uuid
        returning id
      `;
    });
    if (rows.length === 0) return { ok: false, error: 'ドライバーが見つかりません' };
    revalidatePath('/admin/drivers');
    return { ok: true };
  } catch (e) {
    console.error('updateDriver failed:', e);
    return { ok: false, error: 'ドライバーの更新に失敗しました' };
  }
}

export async function deleteDriver(id: string): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) {
    return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  }
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: 'IDの形式が不正です' };
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`delete from drivers where id = ${parsed.data}::uuid returning id`;
    });
    if (rows.length === 0) return { ok: false, error: 'ドライバーが見つかりません' };
    revalidatePath('/admin/drivers');
    return { ok: true };
  } catch (e) {
    console.error('deleteDriver failed:', e);
    return { ok: false, error: 'ドライバーの削除に失敗しました' };
  }
}
```

- [ ] **Step 4: 通ることを確認**

Run: `pnpm test -- tests/integration/ztest-drivers.test.ts`
Expected: PASS（6 件）。

- [ ] **Step 5: コミット**

```bash
git add src/lib/drivers/actions.ts tests/integration/ztest-drivers.test.ts
git commit -m "feat(dispatch): drivers CRUD Server Actions＋統合テスト"
```

---

## Task 3: 登録画面 `/admin/drivers` ＋ ナビ追加

**Files:** Create `src/app/(admin)/admin/drivers/page.tsx`, `.../DriversClient.tsx`; Modify `admin-nav-model.ts`

- [ ] **Step 1: page.tsx を作成**

Create `src/app/(admin)/admin/drivers/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { listDrivers } from '@/lib/drivers/actions';
import { DriversClient } from './DriversClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ドライバー登録' };

export default async function DriversPage() {
  const session = await getDevSession();
  if (!session) redirect('/login');
  const result = await listDrivers();
  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-1">ドライバー登録</h1>
      <p className="text-sm text-adm-muted mb-6">
        ドライバー・車両・識別色を登録します。ここで決めた色が配車ボードで使われます。
      </p>
      <DriversClient
        initialDrivers={result.ok ? (result.data ?? []) : []}
        loadError={result.ok ? undefined : result.error}
        canWrite={can(toActor(session), 'manage_cms')}
      />
    </div>
  );
}
```

- [ ] **Step 2: DriversClient.tsx を作成**

参考モック `.superpowers/brainstorm/1464-1789071838/content/reg-drivers-v6.html`（**週次シフト/シフトメモは含めない**＝フェーズ3）。左=ドライバー一覧（車色帯）、右=編集フォーム（氏名/携帯/NG／車両: 車番/車種/色パレット＋カスタムhex/車の注意）。色パレット定数と custom `<input type="color">` で `vehicleColorHex`＋`vehicleColorName` を持つ。`DispatchRosterClient.tsx` の state 運用（useState/useTransition・openCreate/openEdit/handleSubmit・削除確認）に倣う。`canWrite=false` 時は保存/削除を無効化。管理側日本語直書き可。`any` 禁止。色パレット例:

```ts
const PALETTE: { hex: string; name: string }[] = [
  { hex: '#2B2B2B', name: '黒' }, { hex: '#F5F5F5', name: '白' },
  { hex: '#C0C4C8', name: 'シルバー' }, { hex: '#C0392B', name: '赤' },
  { hex: '#1F3A63', name: '紺' }, { hex: '#2C6152', name: '緑' },
  { hex: '#7A5CB0', name: '紫' }, { hex: '#C9B18A', name: 'ベージュ' },
  { hex: '#D8C39A', name: 'ブロンド' },
];
```

実装要件（受け入れ）:
- 一覧の各行に色帯（`borderLeft: 4px solid vehicleColorHex ?? '#ccc'`）＋氏名＋「車番 車種」。
- 「＋ ドライバー追加」で空フォーム。行クリックで編集。
- 保存で `createDriver`/`updateDriver`、削除は確認後 `deleteDriver`。結果で一覧を再取得 or ローカル更新。
- 色パレットのスウォッチ選択で hex+name をセット。カスタムは `<input type="color">`＋名称テキスト。
- 管理側トークン（`adm-*` or インライン。spec 12-2 明色）。

（完全な TSX は既存 `DispatchRosterClient.tsx` の構造を土台に実装すること。行数が多いのでモックの見た目に寄せる。）

- [ ] **Step 3: ナビに追加**

Modify `src/app/(admin)/_components/admin-nav-model.ts` の「受付・配車」グループ items 末尾に:

```ts
      { href: "/admin/drivers", label: "ドライバー登録" },
```

- [ ] **Step 4: 型・Lint・ビルド**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: すべて成功。

- [ ] **Step 5: ナビ純関数テストが緑のままか確認**

Run: `pnpm test -- src/app/(admin)/_components/admin-nav-model.test.ts`
Expected: PASS（href 一意テストに /admin/drivers が含まれても一意なので緑）。

- [ ] **Step 6: コミット**

```bash
git add "src/app/(admin)/admin/drivers" "src/app/(admin)/_components/admin-nav-model.ts"
git commit -m "feat(dispatch): ドライバー登録画面（一覧＋フォーム・色パレット）＋ナビ追加"
```

---

## Task 4: フェーズ検証

- [ ] **Step 1** Run: `pnpm test` → 全 PASS（新規 ztest-drivers 6 込み）。
- [ ] **Step 2** Run: `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review

- Spec coverage: 設計 4.2（drivers）=Task1-2、登録画面（設計 5.3 ドライバー）=Task3。週次シフト/D&D は範囲外（フェーズ3/4）と明記。
- Placeholder: DB/actions/test は完全コード。UI は既存 `DispatchRosterClient` を土台に実装する指示＋色パレット定数＋受け入れ条件を明示（プレースホルダではなく既存パターン参照）。
- 型整合: `DriverRow`/`createDriver`/`updateDriver`/`deleteDriver`/`listDrivers` を page/client/test が一致して使用。色は `vehicleColorHex`（#RRGGBB）＋`vehicleColorName`。
