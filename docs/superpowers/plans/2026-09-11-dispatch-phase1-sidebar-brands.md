# 配車表 フェーズ1（左サイドバー＋ブランド下地）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理コンソールに左サイドバー（主要ページのピン留め＋グループ分け）を導入し、将来の複数ブランド化の下地となる `brands` マスタ（既定=王様の休日）を用意する。

**Architecture:** (1) `brands` テーブルを手書き SQL マイグレーション（0030）で追加し既定ブランドを固定 UUID で冪等投入。参照は `listBrandsCore`（server-only・RLS 準拠）。(2) 既存の上部ハンバーガーナビ（`AdminNav`）を、グループ化した左サイドバー（`AdminSidebar`）へ置き換える。ナビ項目の分類とアクティブ判定は純関数に切り出して単体テストする。

**Tech Stack:** Next.js 15 App Router / TypeScript strict / postgres.js（生 SQL）/ RLS（`app_current_role()`）/ Vitest（統合は実 Postgres）。設計書: `docs/superpowers/specs/2026-09-11-dispatch-board-rebuild-design.md`（3章＝ブランド、2章＝サイドバー）。

---

## 前提と規約（着手前に読む）

- **マイグレーション**: `migrations/NNNN_name.sql`。`pnpm db:migrate` がファイル名昇順で適用（冪等・`schema_migrations` に記録）。現行最新は `0029_customer_portal_pin.sql` → 本フェーズは **`0030_brands.sql`**。
- **RLS 規約**: `alter table ... enable/force row level security;` ＋ `create policy ... using (app_current_role() in (...))`、`grant ... to app_runtime;`。参照は業務ロール、書込は owner/admin。既存 `migrations/0025_dispatch_ops.sql` の `taxi_companies` が手本。
- **固定 UUID 規約**: seed 参照用に固定 UUID を使う（例 `app_users`=`aaaaaaaa-...`、`therapist_ranks`=`bbbbbbbb-...`）。brands は **`cccccccc-...`** を使う。着手時に衝突が無いことを確認: `git grep -n "cccccccc-0000-4000-9000-000000000001" -- migrations/ scripts/` が0件であること。
- **server-only core の型**: `withUser(sql, session, tx => ...)`（`src/lib/auth/with-user.ts`）。`Session = { userId: string; role: string; therapistId?: string }`（`src/lib/auth/session.ts`）。RLS は `session.role` を見る。
- **統合テスト**: `tests/integration/ztest-*.test.ts`（`ztest-` 接頭辞＝他テストの後に走る・自己完結）。実 Postgres 直結（`postgres(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01")`）。手本 `tests/integration/ztest-dispatch-ops.test.ts`。**seed 済み DB 前提**（`pnpm db:migrate` 済み）。
- **DB 準備**: 実装前に `pnpm db:up`（docker Postgres 起動）→ `pnpm db:migrate`。テストは同じ DB を使う。
- **管理側は日本語直書き可**（公開側の直書き禁止は対象外 / spec 13-1）。**金額は扱わない**フェーズ。`any` 禁止。

---

## File Structure

- **Create** `migrations/0030_brands.sql` — brands テーブル・既定ブランド seed・RLS・grant。
- **Create** `src/lib/brands/queries.ts` — `listBrandsCore(sql, session)`（server-only）。
- **Create** `tests/integration/ztest-brands.test.ts` — seed 存在・listBrandsCore・RLS。
- **Create** `src/app/(admin)/_components/admin-nav-model.ts` — `ADMIN_NAV_GROUPS`（グループ化ナビ定義）＋ `findActiveNavItem`（純関数）。
- **Create** `src/app/(admin)/_components/admin-nav-model.test.ts` — findActiveNavItem の単体テスト。
- **Create** `src/app/(admin)/_components/admin-sidebar.tsx` — 左サイドバー（client）。
- **Modify** `src/app/(admin)/layout.tsx` — 上部ハンバーガー shell → 左サイドバー shell。brand 名を `listBrandsCore` で取得。
- 既存 `src/app/(admin)/_components/admin-nav.tsx` は本フェーズでは削除しない（他から未参照になるが、影響回避のため残置。掃除は後続で可）。

---

## Task 1: brands マイグレーション＋既定ブランド

**Files:**
- Create: `migrations/0030_brands.sql`

- [ ] **Step 1: 固定 UUID の衝突チェック**

Run: `git grep -n "cccccccc-0000-4000-9000-000000000001" -- migrations/ scripts/ ; echo "exit=$?"`
Expected: 出力なし（該当0件。exit=1 = grep ヒットなし）。ヒットしたら別の UUID（`cccccccc-...002` 等）に変える。

- [ ] **Step 2: マイグレーション SQL を作成**

Create `migrations/0030_brands.sql`:

```sql
-- 0030_brands: 店舗ブランドマスタ。現状は「王様の休日（王様）」1件。
-- 将来の複数ブランド化の下地（各運用テーブルに brand_id を持たせる土台 / 設計 3章）。
-- RLS: 参照 = owner/admin/reception/therapist、書込 = owner/admin。

create table if not exists brands (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  short_name  text not null,
  sort_order  int not null default 0,
  is_active   bool not null default true,
  created_at  timestamptz not null default now()
);

-- 既定ブランド「王様の休日（王様）」を固定 UUID で冪等投入
insert into brands (id, name, short_name, sort_order) values
  ('cccccccc-0000-4000-9000-000000000001', '王様の休日', '王様', 1)
on conflict (id) do nothing;

alter table brands enable row level security;
alter table brands force row level security;

drop policy if exists brands_read on brands;
create policy brands_read on brands
  for select
  using (app_current_role() in ('owner','admin','reception','therapist'));

drop policy if exists brands_write on brands;
create policy brands_write on brands
  for all
  using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

grant select, insert, update, delete on brands to app_runtime;
```

- [ ] **Step 3: マイグレーションを適用**

Run: `pnpm db:migrate`
Expected: `適用: 0030_brands.sql` を含む出力（既に適用済みなら「適用すべき新規マイグレーションなし」。冪等）。

- [ ] **Step 4: 既定ブランドが入ったことを確認**

Run: `psql "$DATABASE_URL" -c "select id, name, short_name from brands;"` （psql が無ければ Step は Task 2 のテストで担保されるのでスキップ可）
Expected: `王様の休日 | 王様` の1行。

- [ ] **Step 5: コミット**

```bash
git add migrations/0030_brands.sql
git commit -m "feat(dispatch): brands マスタ（既定=王様の休日）を追加"
```

---

## Task 2: listBrandsCore ＋ 統合テスト（TDD）

**Files:**
- Create: `tests/integration/ztest-brands.test.ts`
- Create: `src/lib/brands/queries.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `tests/integration/ztest-brands.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listBrandsCore } from "@/lib/brands/queries";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

/**
 * brands 統合テスト（0030 / 設計 3章・4.1）。
 * 前提: pnpm db:migrate 適用済み（0030_brands.sql）。db:reset/seed はしない。
 * RLS はロールで判定するため userId は任意の有効な UUID でよい。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

// seed 固定 UUID（ztest-dispatch-ops.test.ts に倣う）
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const ownerSession: Session = { userId: RECEPTION_USER, role: "owner" };
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("listBrandsCore", () => {
  it("既定ブランド『王様の休日』を返す", async () => {
    const brands = await listBrandsCore(sql, ownerSession);
    const king = brands.find((b) => b.name === "王様の休日");
    expect(king).toBeDefined();
    expect(king?.shortName).toBe("王様");
    expect(king?.isActive).toBe(true);
  });

  it("reception でも参照できる（RLS 参照許可）", async () => {
    const brands = await listBrandsCore(sql, receptionSession);
    expect(brands.some((b) => b.name === "王様の休日")).toBe(true);
  });

  it("reception は brands を INSERT できない（RLS 書込拒否）", async () => {
    await expect(
      withUser(sql, receptionSession, async (tx) => {
        return tx`insert into brands (name, short_name) values ('X', 'X') returning id`;
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `pnpm test -- tests/integration/ztest-brands.test.ts`
Expected: FAIL（`Cannot find module '@/lib/brands/queries'` 等の解決エラー）。

- [ ] **Step 3: listBrandsCore を実装**

Create `src/lib/brands/queries.ts`:

```ts
import "server-only";
import type { Sql } from "postgres";
import type { Session } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";

/**
 * ブランド（店舗ブランド）の参照（設計 4.1）。
 * 現状は「王様の休日」1件。将来の複数ブランド化の下地。
 * RLS: 参照は owner/admin/reception/therapist（0030）。
 */
export interface BrandRow {
  id: string;
  name: string;
  shortName: string;
  sortOrder: number;
  isActive: boolean;
}

/** アクティブなブランドを sort_order 昇順で返す。 */
export async function listBrandsCore(sql: Sql, session: Session): Promise<BrandRow[]> {
  const rows = await withUser(sql, session, async (tx) => {
    return tx<
      {
        id: string;
        name: string;
        short_name: string;
        sort_order: number;
        is_active: boolean;
      }[]
    >`
      select id, name, short_name, sort_order, is_active
      from brands
      where is_active = true
      order by sort_order asc, name asc
    `;
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    sortOrder: r.sort_order,
    isActive: r.is_active,
  }));
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `pnpm test -- tests/integration/ztest-brands.test.ts`
Expected: PASS（3 件）。

- [ ] **Step 5: コミット**

```bash
git add src/lib/brands/queries.ts tests/integration/ztest-brands.test.ts
git commit -m "feat(dispatch): listBrandsCore（ブランド参照）＋統合テスト"
```

---

## Task 3: ナビのグループ定義とアクティブ判定（純関数・TDD）

**Files:**
- Create: `src/app/(admin)/_components/admin-nav-model.ts`
- Create: `src/app/(admin)/_components/admin-nav-model.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `src/app/(admin)/_components/admin-nav-model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ADMIN_NAV_GROUPS, findActiveNavItem } from "./admin-nav-model";

describe("ADMIN_NAV_GROUPS", () => {
  it("主要グループが先頭で、4項目をピン留めする", () => {
    const primary = ADMIN_NAV_GROUPS[0];
    expect(primary?.label).toBe("主要");
    expect(primary?.items.map((i) => i.href)).toEqual([
      "/admin/orders",
      "/admin/annai",
      "/admin/dispatch-board",
      "/admin/reservations",
    ]);
  });

  it("全 href が一意（重複リンクを作らない）", () => {
    const hrefs = ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("findActiveNavItem", () => {
  it("完全一致でアクティブ項目を返す", () => {
    const item = findActiveNavItem(ADMIN_NAV_GROUPS, "/admin/annai");
    expect(item?.href).toBe("/admin/annai");
  });

  it("配下パス（前方一致 + '/'）でも親をアクティブにする", () => {
    const item = findActiveNavItem(ADMIN_NAV_GROUPS, "/admin/reservations/abc123");
    expect(item?.href).toBe("/admin/reservations");
  });

  it("最長一致を優先する（/admin/preview/home が /admin より優先）", () => {
    const item = findActiveNavItem(ADMIN_NAV_GROUPS, "/admin/preview/home");
    expect(item?.href).toBe("/admin/preview/home");
  });

  it("該当なしは null", () => {
    expect(findActiveNavItem(ADMIN_NAV_GROUPS, "/admin/does-not-exist")).toBeNull();
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `pnpm test -- src/app/(admin)/_components/admin-nav-model.test.ts`
Expected: FAIL（`Cannot find module './admin-nav-model'`）。

- [ ] **Step 3: ナビモデルを実装**

Create `src/app/(admin)/_components/admin-nav-model.ts`:

```ts
/**
 * 管理サイドバーのナビ定義（設計 2章）とアクティブ判定（純関数）。
 * 既存の全ページをグループへ分類する（リンク欠落を作らない）。
 * 「主要」は電話受付/案内表/配車ボード/予約管理をピン留め。
 * ※ 当日給料（フェーズ8）・ホテルリスト参照（フェーズ7）は各フェーズで主要へ追加する。
 */
export interface AdminNavItem {
  href: string;
  label: string;
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    label: "主要",
    items: [
      { href: "/admin/orders", label: "電話受付" },
      { href: "/admin/annai", label: "案内表" },
      { href: "/admin/dispatch-board", label: "配車ボード" },
      { href: "/admin/reservations", label: "予約管理" },
    ],
  },
  {
    label: "受付・配車",
    items: [
      { href: "/admin/cti", label: "着信" },
      { href: "/admin/phone-confirm", label: "電話確認" },
      { href: "/admin/waitlists", label: "キャンセル待ち" },
      { href: "/admin/history", label: "接客履歴" },
      { href: "/admin/dispatch", label: "配車テキスト" },
      { href: "/admin/dispatch-roster", label: "配車名簿" },
    ],
  },
  {
    label: "会計・報酬",
    items: [
      { href: "/admin/accounting", label: "会計" },
      { href: "/admin/daily-books", label: "日次会計" },
      { href: "/admin/payouts", label: "報酬" },
      { href: "/admin/analytics", label: "集計" },
      { href: "/admin/points", label: "ポイント" },
    ],
  },
  {
    label: "セラピスト・出勤",
    items: [
      { href: "/admin/therapists", label: "セラピスト" },
      { href: "/admin/shifts", label: "出勤登録" },
      { href: "/admin/photo-submissions", label: "写真承認" },
    ],
  },
  {
    label: "コンテンツ・設定",
    items: [
      { href: "/admin/fields", label: "入力項目" },
      { href: "/admin/records", label: "コンテンツ" },
      { href: "/admin/pages", label: "固定ページ" },
      { href: "/admin/lineup", label: "表ページ並び順" },
      { href: "/admin/media", label: "メディア" },
      { href: "/admin/settings", label: "サイト設定" },
      { href: "/admin/areas", label: "派遣エリア" },
      { href: "/admin/hotels", label: "派遣ホテル" },
      { href: "/admin/message-templates", label: "送信テンプレート" },
      { href: "/admin/notifications", label: "通知" },
      { href: "/admin/preview/home", label: "プレビュー" },
      { href: "/admin/ai", label: "AI" },
    ],
  },
];

/**
 * pathname に対応するナビ項目を返す（完全一致 or 前方一致 "href + /"）。
 * 複数一致した時は最長 href を優先（/admin/preview/home が /admin に勝つ）。
 */
export function findActiveNavItem(
  groups: AdminNavGroup[],
  pathname: string,
): AdminNavItem | null {
  let best: AdminNavItem | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(item.href + "/")) {
        if (best === null || item.href.length > best.href.length) {
          best = item;
        }
      }
    }
  }
  return best;
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `pnpm test -- src/app/(admin)/_components/admin-nav-model.test.ts`
Expected: PASS（6 件）。

- [ ] **Step 5: コミット**

```bash
git add "src/app/(admin)/_components/admin-nav-model.ts" "src/app/(admin)/_components/admin-nav-model.test.ts"
git commit -m "feat(dispatch): 管理サイドバーのナビ定義＋アクティブ判定（純関数）"
```

---

## Task 4: AdminSidebar コンポーネント＋レイアウト差し替え

**Files:**
- Create: `src/app/(admin)/_components/admin-sidebar.tsx`
- Modify: `src/app/(admin)/layout.tsx`

- [ ] **Step 1: サイドバーコンポーネントを作成**

Create `src/app/(admin)/_components/admin-sidebar.tsx`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_NAV_GROUPS, findActiveNavItem } from "./admin-nav-model";

/**
 * 管理コンソールの左サイドバー（設計 2章 / nav-shell モック準拠）。
 * - 上: ブランド名（王様の休日）
 * - 主要ピン留め + グループ分け（admin-nav-model）
 * - 狭幅/モバイルはハンバーガーで開閉（md 未満は初期折りたたみ）
 * - フッタ: ロール表示 + ログアウト（server action を props で受ける）
 * 管理側なので日本語直書き可。色は nav-shell モックの配色（インライン）。
 */
export function AdminSidebar({
  brandName,
  roleLabel,
  signOutAction,
}: {
  brandName: string;
  roleLabel: string;
  signOutAction: () => void | Promise<void>;
}) {
  const pathname = usePathname();
  const active = findActiveNavItem(ADMIN_NAV_GROUPS, pathname);
  const [open, setOpen] = useState(false);

  const NAV_BG = "#1E2A27";
  const TEXT = "#dfe6e3";
  const MUTED = "#7f948e";
  const PRIMARY = "#3F7A6B";

  return (
    <>
      {/* モバイル用トグル（md 以上では非表示） */}
      <button
        type="button"
        aria-label="メニュー"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="md:hidden fixed top-3 left-3 z-50 rounded px-3 py-2"
        style={{ background: NAV_BG, color: TEXT }}
      >
        ☰
      </button>

      <aside
        aria-label="管理メニュー"
        className={`${open ? "flex" : "hidden"} md:flex fixed md:sticky top-0 left-0 z-40 h-screen w-[210px] flex-col shrink-0 overflow-y-auto`}
        style={{ background: NAV_BG, color: TEXT, padding: "12px 10px" }}
      >
        <div style={{ padding: "6px 8px 12px", borderBottom: "1px solid rgba(255,255,255,.1)", marginBottom: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{brandName}</div>
          <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>配車・受付コンソール</div>
        </div>

        <nav className="flex-1">
          {ADMIN_NAV_GROUPS.map((group) => (
            <div key={group.label} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: ".06em", padding: "8px 8px 4px" }}>
                {group.label}
              </div>
              {group.items.map((item) => {
                const isActive = active?.href === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    style={{
                      display: "block",
                      padding: "8px 10px",
                      borderRadius: 8,
                      marginBottom: 2,
                      fontSize: 13,
                      fontWeight: isActive ? 700 : 400,
                      color: isActive ? "#fff" : TEXT,
                      background: isActive ? PRIMARY : "transparent",
                      textDecoration: "none",
                    }}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div style={{ marginTop: "auto", paddingTop: 8, borderTop: "1px solid rgba(255,255,255,.1)", fontSize: 12, color: MUTED }}>
          <a href="/" target="_blank" rel="noopener noreferrer" style={{ color: TEXT, display: "block", padding: "6px 8px" }}>
            表ページを見る ↗
          </a>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px" }}>
            <span>{roleLabel}</span>
            <form action={signOutAction}>
              <button type="submit" style={{ color: TEXT, background: "none", border: "none", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
                ログアウト
              </button>
            </form>
          </div>
        </div>
      </aside>
    </>
  );
}
```

- [ ] **Step 2: レイアウトをサイドバー shell に差し替える**

Replace the whole body of `src/app/(admin)/layout.tsx` with:

```tsx
/**
 * 管理画面レイアウト（spec 12-2 / 設計 2章）。
 * 上部ハンバーガー → 左サイドバー shell へ。ブランド名は brands から取得。
 */

import type { Metadata } from "next";
import { getDevSession } from "@/lib/cms/dev-session";
import { getClient } from "@/lib/db-client";
import { listBrandsCore } from "@/lib/brands/queries";
import { signOut } from "@/app/login/actions";
import { AdminSidebar } from "./_components/admin-sidebar";

export const metadata: Metadata = {
  title: {
    template: "%s — 管理画面",
    default: "管理画面",
  },
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getDevSession();

  // ブランド名（既定=王様の休日）。取得失敗時は静的フォールバック。
  let brandName = "王様の休日";
  if (session) {
    try {
      const brands = await listBrandsCore(getClient(), session);
      if (brands[0]) brandName = brands[0].name;
    } catch {
      // フォールバックのまま
    }
  }

  return (
    <div className="min-h-screen bg-adm-bg text-adm-text [color-scheme:light] md:flex">
      <AdminSidebar
        brandName={brandName}
        roleLabel={session ? session.role : "未ログイン"}
        signOutAction={signOut}
      />
      <main className="flex-1 min-w-0 px-6 py-8">{children}</main>
    </div>
  );
}
```

- [ ] **Step 3: 型チェック**

Run: `pnpm typecheck`
Expected: エラーなし（`AdminNav` の未使用 import は layout から消えているので警告も出ない。`admin-nav.tsx` 自体は残置で無害）。

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: エラーなし（`no-explicit-any` 含む）。

- [ ] **Step 5: 本番ビルド（"use server" と Server Actions の相性を確認）**

Run: `pnpm build`
Expected: 成功。`signOut` を client（AdminSidebar）へ props で渡す構成が build を通ること。失敗する場合は `signOut` を薄いラッパ server action で包み直す（`async () => { "use server"; await signOut(); }`）を layout 内に用意して渡す。

- [ ] **Step 6: 目視確認（任意・DB とログインが要る）**

Run: `pnpm dev` → `http://localhost:3000/admin/annai`
Expected: 左に暗色サイドバー・上部に「王様の休日」・主要4項目・グループ分け。現在ページがハイライト。狭幅でハンバーガー開閉。

- [ ] **Step 7: コミット**

```bash
git add "src/app/(admin)/_components/admin-sidebar.tsx" "src/app/(admin)/layout.tsx"
git commit -m "feat(dispatch): 管理コンソールを左サイドバー shell に刷新"
```

---

## Task 5: フェーズ全体の検証

- [ ] **Step 1: 全テスト**

Run: `pnpm test`
Expected: 全 PASS（既存 + 新規 ztest-brands 3件 + admin-nav-model 6件）。既存テストが赤くならないこと。

- [ ] **Step 2: 型・Lint・ビルド一括**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: すべて成功。

- [ ] **Step 3: 直書き日本語などの grep 検査（公開側のみ対象なので管理側は無関係だが慣例で確認）**

Run: `pnpm test`（grep 系テストが含まれていれば緑であること）
Expected: 変化なし（本フェーズは公開側テンプレートに触れていない）。

- [ ] **Step 4: PR 用のまとめ**

ブランチ `feat/dispatch-board-rebuild-design`（設計と同じブランチ）ではなく、実装は新ブランチ `feat/dispatch-phase1-sidebar-brands` を切って進めるのが望ましい（設計 PR と実装 PR を分離）。最終的に PR を作成し、CI 緑・Vercel プレビュー確認までがフェーズ完了条件（CLAUDE.md「各フェーズは reviewer を通す」）。

---

## Self-Review 結果（作成者チェック済み）

- **Spec coverage**: 設計2章（サイドバー）=Task3-4、設計3章/4.1（brands）=Task1-2。フェーズ1のスコープを網羅。当日給料/ホテルリストの主要ピン留めは各担当フェーズで追加する旨をコード注記済み。
- **Placeholder scan**: TODO/TBD なし。各コード step は完全なコードを掲載。
- **型整合**: `AdminNavItem`/`AdminNavGroup`/`findActiveNavItem`/`ADMIN_NAV_GROUPS`（Task3）を Task4 がそのまま import。`listBrandsCore`/`BrandRow`（Task2）を layout が使用。`Session` は `{ userId, role }`。齟齬なし。
- **注意点**: `pnpm test -- <path>` の引数フィルタが環境で効かない場合は `pnpm vitest run <path>` を使う。build で Server Action の props 渡しが失敗したら Task4 Step5 のラッパ回避策を使う。
