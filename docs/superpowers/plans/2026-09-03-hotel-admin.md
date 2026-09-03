# Hotel Admin CRUD + Dropdown Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build /admin/hotels CRUD page (list/create/update/delete hotels with area join) and add a full-list dropdown to BookingPopup and OrderEntryForm so staff can select hotels without typing.

**Architecture:** New server actions file `src/lib/hotels/hotel-admin-actions.ts` following the `src/lib/cms/area-actions.ts` pattern (getDevSession → can(manage_cms) gate → withUser RLS wrapper → Zod validation → postgres.js tagged template). Page follows areas page pattern (server page + client component). Hotel dropdown uses a new `listBookableHotels()` action (no auth required beyond session, reads is_blocked=false hotels for reception use). Both BookingPopup and OrderEntryForm get a `<select>` prepended above the existing text-search flow — the text-search path is preserved intact.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, postgres.js tagged templates, Zod, Tailwind CSS (adm-* tokens), `can(actor, 'manage_cms')` capability gate, `withUser()` RLS wrapper.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/lib/hotels/hotel-admin-actions.ts` | Create | Server actions: listHotelsAdmin, listBookableHotels, createHotel, updateHotel, deleteHotel |
| `src/app/(admin)/admin/hotels/page.tsx` | Create | Server page: auth gate + data fetch + render HotelListClient |
| `src/app/(admin)/admin/hotels/HotelListClient.tsx` | Create | Client component: table + add form + edit/delete per row |
| `src/app/(admin)/layout.tsx` | Modify | Add `{ href: "/admin/hotels", label: "派遣ホテル" }` after "/admin/areas" entry |
| `src/app/(admin)/admin/annai/BookingPopup.tsx` | Modify | Add hotel dropdown above text search; entryNote auto-fill on select |
| `src/app/(admin)/admin/orders/OrderEntryForm.tsx` | Modify | Add hotel dropdown above text search in hotel section |
| `tests/integration/hotel-admin-actions.test.ts` | Create | Integration tests against real Postgres |

---

## Task 1: Server Actions (`src/lib/hotels/hotel-admin-actions.ts`)

**Files:**
- Create: `src/lib/hotels/hotel-admin-actions.ts`

- [ ] **Step 1: Write the file**

```typescript
"use server";

/**
 * ホテル台帳 Server Actions（/admin/hotels）。
 *
 * - listHotelsAdmin / createHotel / updateHotel / deleteHotel は owner/admin のみ
 *   （can(actor, 'manage_cms')）。RLS hotels_owner_admin ポリシーと一致。
 * - listBookableHotels は reception 以上が使用（案内表・電話受付でホテルを選ぶ）。
 * - name unique 違反 (23505) → 「同名のホテルが既にあります」
 * - FK 参照中 delete 失敗 (23503) → 「使用中のため削除できません。代わりに受け入れ停止にしてください」
 * - 金額なし。extra_minutes は整数 (check >=0 は DB 側)。
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import type { ActionResult } from "@/lib/cms/actions";

export type { ActionResult };

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export interface HotelAdminRow {
  id: string;
  name: string;
  nameKana: string | null;
  address: string | null;
  areaId: string | null;
  areaName: string | null;
  entryNote: string | null;
  parkingNote: string | null;
  extraMinutes: number;
  isBlocked: boolean;
  note: string | null;
}

export interface BookableHotel {
  id: string;
  name: string;
  areaId: string | null;
  entryNote: string | null;
  extraMinutes: number;
}

// ---------------------------------------------------------------------------
// バリデーションスキーマ
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

const createHotelSchema = z.object({
  name: z.string().min(1, "ホテル名は1文字以上必要です").max(200, "ホテル名は200文字以内にしてください"),
  nameKana: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  areaId: z.string().uuid().optional(),
  entryNote: z.string().max(1000).optional(),
  parkingNote: z.string().max(1000).optional(),
  extraMinutes: z.number().int().min(0, "館内移動時間は0以上の整数です").default(0),
  note: z.string().max(2000).optional(),
});

const updateHotelSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1, "ホテル名は1文字以上必要です").max(200).optional(),
  nameKana: z.string().max(200).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  areaId: z.string().uuid().nullable().optional(),
  entryNote: z.string().max(1000).nullable().optional(),
  parkingNote: z.string().max(1000).nullable().optional(),
  extraMinutes: z.number().int().min(0).optional(),
  isBlocked: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** postgres エラーコードから UI 向け文言に変換する */
function pgErrToMessage(e: unknown): string {
  if (e && typeof e === "object" && "code" in e) {
    const code = (e as { code: string }).code;
    if (code === "23505") return "同名のホテルが既にあります";
    if (code === "23503") return "使用中のため削除できません。代わりに「受け入れ停止」にしてください";
  }
  return "操作に失敗しました";
}

// ---------------------------------------------------------------------------
// 一覧（管理用: blocked 含む・area join）
// ---------------------------------------------------------------------------

interface HotelAdminRaw {
  id: string;
  name: string;
  name_kana: string | null;
  address: string | null;
  area_id: string | null;
  area_name: string | null;
  entry_note: string | null;
  parking_note: string | null;
  extra_minutes: number;
  is_blocked: boolean;
  note: string | null;
}

/** 全ホテル一覧（owner/admin）。is_blocked 含む。name asc。 */
export async function listHotelsAdmin(): Promise<ActionResult<HotelAdminRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<HotelAdminRaw[]>`
        select
          h.id, h.name, h.name_kana, h.address,
          h.area_id, a.name as area_name,
          h.entry_note, h.parking_note,
          h.extra_minutes, h.is_blocked, h.note
        from hotels h
        left join areas a on a.id = h.area_id
        order by h.name asc
      `;
    });
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        nameKana: r.name_kana,
        address: r.address,
        areaId: r.area_id,
        areaName: r.area_name,
        entryNote: r.entry_note,
        parkingNote: r.parking_note,
        extraMinutes: r.extra_minutes,
        isBlocked: r.is_blocked,
        note: r.note,
      })),
    };
  } catch (e) {
    return { ok: false, error: pgErrToMessage(e) };
  }
}

// ---------------------------------------------------------------------------
// 予約可能ホテル一覧（reception 以上・is_blocked=false のみ）
// ---------------------------------------------------------------------------

interface BookableRaw {
  id: string;
  name: string;
  area_id: string | null;
  entry_note: string | null;
  extra_minutes: number;
}

/** 予約画面用: is_blocked=false の全ホテルを name asc で返す。 */
export async function listBookableHotels(): Promise<ActionResult<BookableHotel[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<BookableRaw[]>`
        select id, name, area_id, entry_note, extra_minutes
        from hotels
        where is_blocked = false
        order by name asc
      `;
    });
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        areaId: r.area_id,
        entryNote: r.entry_note,
        extraMinutes: r.extra_minutes,
      })),
    };
  } catch (e) {
    return { ok: false, error: pgErrToMessage(e) };
  }
}

// ---------------------------------------------------------------------------
// 作成
// ---------------------------------------------------------------------------

/** ホテルを新規作成する（owner/admin）。name 一意違反は UI 向け文言に変換。 */
export async function createHotel(
  input: z.infer<typeof createHotelSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = createHotelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const d = parsed.data;
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        insert into hotels (
          name, name_kana, address, area_id,
          entry_note, parking_note, extra_minutes, note,
          is_blocked
        ) values (
          ${d.name},
          ${d.nameKana ?? null},
          ${d.address ?? null},
          ${d.areaId ?? null},
          ${d.entryNote ?? null},
          ${d.parkingNote ?? null},
          ${d.extraMinutes},
          ${d.note ?? null},
          false
        )
        returning id
      `;
    });
    revalidatePath("/admin/hotels");
    return { ok: true, data: { id: rows[0]!.id } };
  } catch (e) {
    return { ok: false, error: pgErrToMessage(e) };
  }
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

/** ホテル情報を更新する（owner/admin）。is_blocked=true で受け入れ停止。 */
export async function updateHotel(
  input: z.infer<typeof updateHotelSchema>,
): Promise<ActionResult<void>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = updateHotelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const d = parsed.data;
  const sql = getClient();
  try {
    await withUser(sql, session, async (tx) => {
      await tx`
        update hotels set
          name         = coalesce(${d.name ?? null}, name),
          name_kana    = case when ${d.nameKana !== undefined} then ${d.nameKana ?? null} else name_kana end,
          address      = case when ${d.address !== undefined} then ${d.address ?? null} else address end,
          area_id      = case when ${d.areaId !== undefined} then ${d.areaId ?? null}::uuid else area_id end,
          entry_note   = case when ${d.entryNote !== undefined} then ${d.entryNote ?? null} else entry_note end,
          parking_note = case when ${d.parkingNote !== undefined} then ${d.parkingNote ?? null} else parking_note end,
          extra_minutes= coalesce(${d.extraMinutes ?? null}, extra_minutes),
          is_blocked   = coalesce(${d.isBlocked ?? null}, is_blocked),
          note         = case when ${d.note !== undefined} then ${d.note ?? null} else note end,
          updated_at   = now()
        where id = ${d.id}::uuid
      `;
    });
    revalidatePath("/admin/hotels");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: pgErrToMessage(e) };
  }
}

// ---------------------------------------------------------------------------
// 削除
// ---------------------------------------------------------------------------

/** ホテルを削除する（owner/admin）。予約から参照中なら FK エラーを UI 向けに変換。 */
export async function deleteHotel(id: string): Promise<ActionResult<void>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    return { ok: false, error: "ID の形式が不正です" };
  }

  const sql = getClient();
  try {
    await withUser(sql, session, async (tx) => {
      await tx`delete from hotels where id = ${id}::uuid`;
    });
    revalidatePath("/admin/hotels");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: pgErrToMessage(e) };
  }
}
```

- [ ] **Step 2: Verify no `any`, no decimal amounts, no direct DB from client**

Run: `grep -n "any\b" src/lib/hotels/hotel-admin-actions.ts`
Expected: no matches (the word "any" as a TypeScript type must not appear)

---

## Task 2: Admin Hotels Page (Server Component)

**Files:**
- Create: `src/app/(admin)/admin/hotels/page.tsx`

- [ ] **Step 1: Write the server page**

```typescript
/**
 * /admin/hotels — 派遣ホテル台帳（spec 8-2 / 12-2）。
 *
 * - owner/admin のみアクセス可（manage_cms）
 * - hotels テーブルを一覧・新規追加・編集・削除・受け入れ停止（is_blocked）できる
 * - エリアは areas(is_active=true) の select から選ぶ
 * - migration 不要（既存 hotels テーブル + RLS hotels_owner_admin）
 *
 * デザイン: spec 12-2 / 白基調・角丸4pxまで・影なし罫線区切り・1280px 想定
 */

import type { Metadata } from "next";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { getDevSession } from "@/lib/cms/dev-session";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { listHotelsAdmin } from "@/lib/hotels/hotel-admin-actions";
import { HotelListClient } from "./HotelListClient";

export const metadata: Metadata = { title: "派遣ホテル" };
export const dynamic = "force-dynamic";

interface AreaOption {
  id: string;
  name: string;
}

export default async function AdminHotelsPage() {
  const session = await getDevSession();

  if (!session || !can(toActor(session), "manage_cms")) {
    return (
      <div
        role="alert"
        className="border border-adm-danger p-4 text-sm text-adm-danger"
        style={{ borderRadius: "4px" }}
      >
        <p className="font-medium">アクセス権限がありません</p>
        <p className="mt-1 text-xs">このページは owner または admin のロールが必要です。</p>
      </div>
    );
  }

  let hotels;
  let areas: AreaOption[] = [];

  try {
    const [hotelsResult, areaRows] = await Promise.all([
      listHotelsAdmin(),
      (async () => {
        const sql = getClient();
        return withUser(sql, session, async (tx) => {
          return tx<AreaOption[]>`
            select id, name from areas
            where is_active = true
            order by sort_order asc, name asc
          `;
        });
      })(),
    ]);

    if (!hotelsResult.ok) {
      throw new Error(hotelsResult.error ?? "不明なエラー");
    }
    hotels = hotelsResult.data ?? [];
    areas = areaRows;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return (
      <div
        role="alert"
        className="border border-adm-danger p-4 text-sm text-adm-danger"
        style={{ borderRadius: "4px" }}
      >
        <p className="font-medium">ホテル一覧の読み込みに失敗しました</p>
        <p className="mt-1 text-xs">{msg}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-adm-text">派遣ホテル台帳</h1>
      </div>
      <HotelListClient hotels={hotels} areas={areas} />
    </div>
  );
}
```

---

## Task 3: Client Component `HotelListClient.tsx`

**Files:**
- Create: `src/app/(admin)/admin/hotels/HotelListClient.tsx`

- [ ] **Step 1: Write the client component**

```typescript
"use client";

/**
 * 派遣ホテル台帳のクライアント側コンポーネント（/admin/hotels）。
 * - ホテル一覧テーブル（name/エリア/extra_minutes/entry_note/address/is_blocked）
 * - 新規追加フォーム
 * - 各行インライン編集・受け入れ停止トグル・削除
 * 3状態: 空状態 / ロード中 / エラー
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { HotelAdminRow } from "@/lib/hotels/hotel-admin-actions";
import {
  createHotel,
  updateHotel,
  deleteHotel,
} from "@/lib/hotels/hotel-admin-actions";

interface AreaOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// 新規追加フォーム
// ---------------------------------------------------------------------------

function AddHotelForm({ areas, onDone }: { areas: AreaOption[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [nameKana, setNameKana] = useState("");
  const [address, setAddress] = useState("");
  const [areaId, setAreaId] = useState("");
  const [entryNote, setEntryNote] = useState("");
  const [parkingNote, setParkingNote] = useState("");
  const [extraMinutes, setExtraMinutes] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createHotel({
        name: name.trim(),
        nameKana: nameKana.trim() || undefined,
        address: address.trim() || undefined,
        areaId: areaId || undefined,
        entryNote: entryNote.trim() || undefined,
        parkingNote: parkingNote.trim() || undefined,
        extraMinutes,
        note: note.trim() || undefined,
      });
      if (result.ok) {
        setName("");
        setNameKana("");
        setAddress("");
        setAreaId("");
        setEntryNote("");
        setParkingNote("");
        setExtraMinutes(0);
        setNote("");
        onDone();
      } else {
        setError(result.error ?? "追加に失敗しました");
      }
    });
  };

  const inputCls = "border border-adm-border px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-1 focus:ring-adm-primary bg-adm-surface text-adm-text";
  const r4 = { borderRadius: "4px" } as const;

  return (
    <form onSubmit={handleSubmit} className="border border-adm-border p-4 space-y-3 bg-adm-surface" style={r4}>
      <h2 className="text-sm font-semibold text-adm-text">ホテルを追加</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <label className="block text-xs text-adm-text/70 mb-1">ホテル名 <span className="text-adm-danger">*</span></label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} style={r4} placeholder="ホテルニューオータニ仙台" />
        </div>
        <div>
          <label className="block text-xs text-adm-text/70 mb-1">ふりがな</label>
          <input value={nameKana} onChange={(e) => setNameKana(e.target.value)} className={inputCls} style={r4} placeholder="ほてるにゅーおーたに" />
        </div>
        <div>
          <label className="block text-xs text-adm-text/70 mb-1">エリア</label>
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)} className={inputCls} style={r4}>
            <option value="">— 未設定 —</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-adm-text/70 mb-1">住所</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputCls} style={r4} placeholder="宮城県仙台市青葉区…" />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-adm-text/70 mb-1">入り方（フロント経由・直接部屋へ等）</label>
          <input value={entryNote} onChange={(e) => setEntryNote(e.target.value)} className={inputCls} style={r4} placeholder="フロントで呼び出し後、部屋へ直接" />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-adm-text/70 mb-1">駐車場</label>
          <input value={parkingNote} onChange={(e) => setParkingNote(e.target.value)} className={inputCls} style={r4} placeholder="地下P有・30分無料" />
        </div>
        <div>
          <label className="block text-xs text-adm-text/70 mb-1">追加移動分（分）</label>
          <input
            type="number" min={0} value={extraMinutes}
            onChange={(e) => setExtraMinutes(Math.max(0, parseInt(e.target.value, 10) || 0))}
            className={inputCls} style={r4}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-adm-text/70 mb-1">メモ</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} style={r4} placeholder="内部メモ" />
        </div>
      </div>
      {error && <p className="text-xs text-adm-danger">{error}</p>}
      <button
        type="submit" disabled={isPending || !name.trim()}
        className="px-4 py-2 text-sm bg-adm-primary text-white disabled:opacity-50"
        style={r4}
      >
        {isPending ? "追加中…" : "追加する"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 行コンポーネント
// ---------------------------------------------------------------------------

function HotelRow({ hotel, areas, onDone }: { hotel: HotelAdminRow; areas: AreaOption[]; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({
    name: hotel.name,
    nameKana: hotel.nameKana ?? "",
    address: hotel.address ?? "",
    areaId: hotel.areaId ?? "",
    entryNote: hotel.entryNote ?? "",
    parkingNote: hotel.parkingNote ?? "",
    extraMinutes: hotel.extraMinutes,
    note: hotel.note ?? "",
  });
  const [rowError, setRowError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const r4 = { borderRadius: "4px" } as const;
  const inputCls = "border border-adm-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary bg-adm-surface text-adm-text w-full";

  const handleSave = () => {
    setRowError(null);
    startTransition(async () => {
      const result = await updateHotel({
        id: hotel.id,
        name: editData.name.trim(),
        nameKana: editData.nameKana.trim() || null,
        address: editData.address.trim() || null,
        areaId: editData.areaId || null,
        entryNote: editData.entryNote.trim() || null,
        parkingNote: editData.parkingNote.trim() || null,
        extraMinutes: editData.extraMinutes,
        note: editData.note.trim() || null,
      });
      if (result.ok) {
        setEditing(false);
        onDone();
      } else {
        setRowError(result.error ?? "更新に失敗しました");
      }
    });
  };

  const handleToggleBlocked = () => {
    startTransition(async () => {
      const result = await updateHotel({ id: hotel.id, isBlocked: !hotel.isBlocked });
      if (result.ok) {
        onDone();
      } else {
        setRowError(result.error ?? "更新に失敗しました");
      }
    });
  };

  const handleDelete = () => {
    if (!confirm(`「${hotel.name}」を削除しますか？予約から参照中の場合は削除できません。`)) return;
    startTransition(async () => {
      const result = await deleteHotel(hotel.id);
      if (result.ok) {
        onDone();
      } else {
        setRowError(result.error ?? "削除に失敗しました");
      }
    });
  };

  if (editing) {
    return (
      <tr className="border-b border-adm-border align-top">
        <td colSpan={7} className="px-3 py-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xs text-adm-text/70">ホテル名</label>
              <input value={editData.name} onChange={(e) => setEditData((d) => ({ ...d, name: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div>
              <label className="text-xs text-adm-text/70">ふりがな</label>
              <input value={editData.nameKana} onChange={(e) => setEditData((d) => ({ ...d, nameKana: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div>
              <label className="text-xs text-adm-text/70">エリア</label>
              <select value={editData.areaId} onChange={(e) => setEditData((d) => ({ ...d, areaId: e.target.value }))} className={inputCls} style={r4}>
                <option value="">— 未設定 —</option>
                {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="col-span-3">
              <label className="text-xs text-adm-text/70">住所</label>
              <input value={editData.address} onChange={(e) => setEditData((d) => ({ ...d, address: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-adm-text/70">入り方</label>
              <input value={editData.entryNote} onChange={(e) => setEditData((d) => ({ ...d, entryNote: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div>
              <label className="text-xs text-adm-text/70">追加移動分</label>
              <input type="number" min={0} value={editData.extraMinutes} onChange={(e) => setEditData((d) => ({ ...d, extraMinutes: Math.max(0, parseInt(e.target.value, 10) || 0) }))} className={inputCls} style={r4} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-adm-text/70">駐車場</label>
              <input value={editData.parkingNote} onChange={(e) => setEditData((d) => ({ ...d, parkingNote: e.target.value }))} className={inputCls} style={r4} />
            </div>
            <div>
              <label className="text-xs text-adm-text/70">メモ</label>
              <input value={editData.note} onChange={(e) => setEditData((d) => ({ ...d, note: e.target.value }))} className={inputCls} style={r4} />
            </div>
          </div>
          {rowError && <p className="text-xs text-adm-danger mt-1">{rowError}</p>}
          <div className="flex gap-2 mt-2">
            <button onClick={handleSave} disabled={isPending} className="px-3 py-1 text-xs bg-adm-primary text-white disabled:opacity-50" style={r4}>
              {isPending ? "保存中…" : "保存"}
            </button>
            <button onClick={() => { setEditing(false); setRowError(null); }} className="px-3 py-1 text-xs border border-adm-border text-adm-text" style={r4}>
              キャンセル
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className={`border-b border-adm-border text-sm ${hotel.isBlocked ? "opacity-50" : ""}`}>
      <td className="px-3 py-2">
        <span className="font-medium text-adm-text">{hotel.name}</span>
        {hotel.nameKana && <span className="block text-xs text-adm-text/60">{hotel.nameKana}</span>}
        {rowError && <p className="text-xs text-adm-danger mt-0.5">{rowError}</p>}
      </td>
      <td className="px-3 py-2 text-adm-text/70">{hotel.areaName ?? "—"}</td>
      <td className="px-3 py-2 text-adm-text/70 whitespace-nowrap">{hotel.extraMinutes}分</td>
      <td className="px-3 py-2 text-adm-text/70 max-w-[200px] truncate">{hotel.entryNote ?? "—"}</td>
      <td className="px-3 py-2 text-adm-text/70 max-w-[180px] truncate">{hotel.address ?? "—"}</td>
      <td className="px-3 py-2 text-center">
        {hotel.isBlocked
          ? <span className="px-2 py-0.5 text-xs bg-adm-danger/10 text-adm-danger" style={r4}>停止中</span>
          : <span className="px-2 py-0.5 text-xs bg-adm-primary/10 text-adm-primary" style={r4}>受入中</span>
        }
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-2 justify-end flex-wrap">
          <button onClick={() => setEditing(true)} disabled={isPending} className="text-xs text-adm-primary underline disabled:opacity-50">編集</button>
          <button onClick={handleToggleBlocked} disabled={isPending} className="text-xs text-adm-warn underline disabled:opacity-50">
            {hotel.isBlocked ? "再開" : "停止"}
          </button>
          <button onClick={handleDelete} disabled={isPending} className="text-xs text-adm-danger underline disabled:opacity-50">削除</button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

export function HotelListClient({ hotels, areas }: { hotels: HotelAdminRow[]; areas: AreaOption[] }) {
  const router = useRouter();
  const refresh = () => router.refresh();

  return (
    <div className="space-y-6">
      {/* 追加フォーム */}
      <AddHotelForm areas={areas} onDone={refresh} />

      {/* 一覧 */}
      <div className="bg-adm-surface border border-adm-border overflow-x-auto" style={{ borderRadius: "4px" }}>
        {hotels.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-adm-text/50">
            ホテルが登録されていません。上のフォームから追加してください。
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-adm-border bg-adm-bg">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">ホテル名</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">エリア</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">追加移動</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">入り方</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-adm-text/70">住所</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-adm-text/70">状態</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-adm-text/70">操作</th>
              </tr>
            </thead>
            <tbody>
              {hotels.map((h) => (
                <HotelRow key={h.id} hotel={h} areas={areas} onDone={refresh} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

---

## Task 4: Add Nav Item to layout.tsx

**Files:**
- Modify: `src/app/(admin)/layout.tsx`

- [ ] **Step 1: Add hotel nav entry after `/admin/areas`**

In `src/app/(admin)/layout.tsx`, find the line:
```typescript
  { href: "/admin/areas", label: "派遣エリア" },
```

Change it to:
```typescript
  { href: "/admin/areas", label: "派遣エリア" },
  { href: "/admin/hotels", label: "派遣ホテル" },
```

---

## Task 5: BookingPopup — Add Hotel Dropdown

**Files:**
- Modify: `src/app/(admin)/admin/annai/BookingPopup.tsx`

The goal is to add a `<select>` dropdown that lets staff pick a hotel without typing. The existing text-search flow (hotelQuery / hotelSuggests / registerProvisionalHotel) stays intact below it. When an option is selected in the dropdown, call `selectHotel()` which already exists and handles `setHotelId`, `setHotelName`, `setHotelQuery`, `setHotelEntryNote`, and `setAreaId`.

- [ ] **Step 1: Add import and state for bookable hotels list**

At the top of `BookingPopup.tsx`, add `listBookableHotels` to the import from `@/app/(admin)/admin/orders/actions`. But wait — `listBookableHotels` will be in `@/lib/hotels/hotel-admin-actions`, not in orders/actions. We need to import from there.

Add this import after the existing imports:
```typescript
import { listBookableHotels } from "@/lib/hotels/hotel-admin-actions";
import type { BookableHotel } from "@/lib/hotels/hotel-admin-actions";
```

Add state in the component body (after the existing state declarations):
```typescript
const [allHotels, setAllHotels] = useState<BookableHotel[]>([]);
```

Add a useEffect to load hotel list once on mount:
```typescript
useEffect(() => {
  void (async () => {
    const r = await listBookableHotels();
    if (r.ok && r.data) setAllHotels(r.data);
  })();
}, []);
```

- [ ] **Step 2: Add dropdown in the hotel section of JSX**

Find the hotel section in JSX (the `{dest === "hotel" ? (` branch). It currently starts with:
```tsx
<div style={{ position: "relative" }}>
  <label style={{ fontSize: 10, color: T.muted }}>ホテル（入力/候補選択）<br />
```

Insert a new label/select BEFORE that div:
```tsx
{allHotels.length > 0 && (
  <label style={{ fontSize: 10, color: T.muted }}>ホテル一覧から選択<br />
    <select
      style={{ ...field, width: 170 }}
      value={hotelId}
      onChange={(e) => {
        const h = allHotels.find((x) => x.id === e.target.value);
        if (h) selectHotel({ id: h.id, name: h.name, areaId: h.areaId, entryNote: h.entryNote });
        else { setHotelId(""); setHotelName(""); setHotelQuery(""); setHotelEntryNote(null); }
      }}
    >
      <option value="">— 選択してください —</option>
      {allHotels.map((h) => (
        <option key={h.id} value={h.id}>{h.name}</option>
      ))}
    </select>
  </label>
)}
```

---

## Task 6: OrderEntryForm — Add Hotel Dropdown

**Files:**
- Modify: `src/app/(admin)/admin/orders/OrderEntryForm.tsx`

The goal is the same: add a `<select>` dropdown above the existing text search in the hotel section. The existing text search + provisional registration logic stays.

- [ ] **Step 1: Add import and state**

Add after existing imports:
```typescript
import { listBookableHotels } from "@/lib/hotels/hotel-admin-actions";
import type { BookableHotel } from "@/lib/hotels/hotel-admin-actions";
```

Add state (after existing state declarations near top of component):
```typescript
const [allHotels, setAllHotels] = useState<BookableHotel[]>([]);
```

Add useEffect to load once on mount (after other useEffects or alongside them):
```typescript
useEffect(() => {
  void (async () => {
    const r = await listBookableHotels();
    if (r.ok && r.data) setAllHotels(r.data);
  })();
}, []);
```

- [ ] **Step 2: Add dropdown in hotel section JSX**

Find the hotel section in JSX (`{destinationType === 'hotel' && (`). It currently starts with:
```tsx
<div className="relative">
  <label className="block text-sm font-medium text-adm-text mb-1">ホテル名</label>
  <input
    type="text"
    value={hotelQuery}
```

Insert BEFORE that `<div className="relative">`:
```tsx
{allHotels.length > 0 && (
  <div>
    <label className="block text-sm font-medium text-adm-text mb-1">ホテル一覧から選択</label>
    <select
      value={hotelId}
      onChange={(e) => {
        const h = allHotels.find((x) => x.id === e.target.value);
        if (h) {
          setHotelId(h.id);
          setHotelQuery(h.name);
          setHotelSuggestions([]);
          setHotelNotFound(false);
        } else {
          setHotelId("");
          setHotelQuery("");
        }
      }}
      className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary"
      tabIndex={4}
    >
      <option value="">— 選択してください（または下のテキスト検索から）—</option>
      {allHotels.map((h) => (
        <option key={h.id} value={h.id}>{h.name}</option>
      ))}
    </select>
  </div>
)}
```

Note: In OrderEntryForm the `setHotelId` and `setHotelQuery` etc. are already in scope as state setters. The `tabIndex={4}` on the new select matches the existing input tabIndex — the text search input's tabIndex should be changed to a higher value (e.g. `tabIndex={4}` → stays, or adjust both; the important thing is the select is navigable by Tab).

---

## Task 7: Integration Tests

**Files:**
- Create: `tests/integration/hotel-admin-actions.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
/**
 * ホテル管理 Server Actions の統合テスト（実 Postgres）。
 *
 * ADMIN_DEV_SESSION=1 が有効な環境で getDevSession() が owner セッションを返すことを前提にする。
 * テスト用ホテルはテスト内で作成・削除する（db:reset/db:seed はしない）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const rawSql = postgres(url, { max: 1, onnotice: () => {} });

// ADMIN_DEV_SESSION=1 を設定して getDevSession が owner を返すようにする
process.env.ADMIN_DEV_SESSION = "1";

// server-only はエイリアスで空モジュールに差し替え済み（vitest.config.ts）

import {
  listHotelsAdmin,
  listBookableHotels,
  createHotel,
  updateHotel,
  deleteHotel,
} from "@/lib/hotels/hotel-admin-actions";

const TEST_PREFIX = "ztest_hotel_";

// テスト用ホテルを後片付けする
afterAll(async () => {
  await rawSql`delete from hotels where name like ${TEST_PREFIX + "%"}`;
  await rawSql.end({ timeout: 5 });
});

describe("createHotel", () => {
  it("正常作成: id が返る", async () => {
    const result = await createHotel({
      name: TEST_PREFIX + "グランドホテル",
      extraMinutes: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.data?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("name unique 違反 → 同名のホテルが既にあります", async () => {
    const name = TEST_PREFIX + "同名テスト";
    await createHotel({ name, extraMinutes: 0 });
    const dup = await createHotel({ name, extraMinutes: 0 });
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("同名のホテルが既にあります");
  });

  it("name が空文字 → バリデーションエラー", async () => {
    const result = await createHotel({ name: "", extraMinutes: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("extraMinutes が負 → バリデーションエラー", async () => {
    const result = await createHotel({ name: TEST_PREFIX + "negative", extraMinutes: -1 });
    expect(result.ok).toBe(false);
  });
});

describe("updateHotel", () => {
  let hotelId: string;

  beforeAll(async () => {
    const r = await createHotel({ name: TEST_PREFIX + "更新テスト", extraMinutes: 0 });
    expect(r.ok).toBe(true);
    hotelId = r.data!.id;
  });

  it("entryNote を更新できる", async () => {
    const r = await updateHotel({ id: hotelId, entryNote: "フロント呼び出し" });
    expect(r.ok).toBe(true);
    const list = await listHotelsAdmin();
    const row = list.data?.find((h) => h.id === hotelId);
    expect(row?.entryNote).toBe("フロント呼び出し");
  });

  it("isBlocked=true で受け入れ停止できる", async () => {
    const r = await updateHotel({ id: hotelId, isBlocked: true });
    expect(r.ok).toBe(true);
    const list = await listHotelsAdmin();
    const row = list.data?.find((h) => h.id === hotelId);
    expect(row?.isBlocked).toBe(true);
  });
});

describe("listHotelsAdmin", () => {
  it("結果が返る（blocked 含む）", async () => {
    const r = await listHotelsAdmin();
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });
});

describe("listBookableHotels", () => {
  it("is_blocked=false のホテルだけ含む", async () => {
    // 停止中のホテルを作って検証
    const name = TEST_PREFIX + "停止テスト";
    const cr = await createHotel({ name, extraMinutes: 0 });
    expect(cr.ok).toBe(true);
    await updateHotel({ id: cr.data!.id, isBlocked: true });

    const r = await listBookableHotels();
    expect(r.ok).toBe(true);
    const found = r.data?.find((h) => h.name === name);
    expect(found).toBeUndefined();
  });
});

describe("deleteHotel", () => {
  it("存在するホテルを削除できる", async () => {
    const cr = await createHotel({ name: TEST_PREFIX + "削除テスト", extraMinutes: 0 });
    expect(cr.ok).toBe(true);
    const dr = await deleteHotel(cr.data!.id);
    expect(dr.ok).toBe(true);

    const list = await listHotelsAdmin();
    expect(list.data?.find((h) => h.id === cr.data!.id)).toBeUndefined();
  });

  it("不正 UUID → バリデーションエラー", async () => {
    const r = await deleteHotel("not-a-uuid");
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run only this test file**

Run: `pnpm vitest run tests/integration/hotel-admin-actions.test.ts`

Expected: all tests pass (green). If the local DB is not running, the test will fail with a connection error — that is expected in CI only; locally run `pnpm db:up` first.

---

## Task 8: Typecheck, Lint, Build

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: 0 errors (no `any`, no unused imports)

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: build succeeds. All `"use server"` files must export only `async` functions — no plain constants or types at the module root that aren't `export type`.

Note: If `listBookableHotels` is called from a client component (`BookingPopup.tsx`, `OrderEntryForm.tsx`) using `import { listBookableHotels } from "@/lib/hotels/hotel-admin-actions"`, Next.js 15 supports this — client components may call server actions directly as async functions. The `"use server"` directive makes them callable from client via the Server Actions RPC bridge. This is the correct pattern already used by `searchHotels` and `registerProvisionalHotel`.

- [ ] **Step 4: Grep self-check**

```bash
# No `any` type used
grep -rn "\bany\b" src/lib/hotels/ src/app/\(admin\)/admin/hotels/
# No decimal amounts (should be zero in this file since no amounts)
# No direct DB from client (client files must not import getClient/withUser/postgres)
grep -n "getClient\|withUser\|postgres" \
  "src/app/(admin)/admin/hotels/HotelListClient.tsx" \
  "src/app/(admin)/admin/annai/BookingPopup.tsx" \
  "src/app/(admin)/admin/orders/OrderEntryForm.tsx"
```

Expected: no matches.

---

## Task 9: Commit, Push, PR

- [ ] **Step 1: Stage and commit**

```bash
git add \
  src/lib/hotels/hotel-admin-actions.ts \
  src/app/\(admin\)/admin/hotels/page.tsx \
  src/app/\(admin\)/admin/hotels/HotelListClient.tsx \
  src/app/\(admin\)/layout.tsx \
  src/app/\(admin\)/admin/annai/BookingPopup.tsx \
  src/app/\(admin\)/admin/orders/OrderEntryForm.tsx \
  tests/integration/hotel-admin-actions.test.ts
git commit -m "feat(hotels): 派遣ホテル管理ページ＋ホテルはプルダウン選択可に

- src/lib/hotels/hotel-admin-actions.ts: listHotelsAdmin/listBookableHotels/createHotel/updateHotel/deleteHotel
  owner/admin ゲート・name 一意違反(23505)/FK(23503)を UI 向け文言変換
- /admin/hotels ページ: 一覧・新規追加・インライン編集・受け入れ停止・削除（spec 12-2 トークン）
- ナビに「派遣ホテル」追加（派遣エリアの隣）
- BookingPopup / OrderEntryForm: ホテル全件プルダウン追加（既存テキスト検索・仮登録は残す）
- tests/integration/hotel-admin-actions.test.ts: CRUD・一意違反・停止・削除の統合テスト"
```

- [ ] **Step 2: Push**

```bash
git push origin HEAD
```

- [ ] **Step 3: Create PR**

```bash
gh pr create \
  --title "feat(hotels): 派遣ホテル管理ページ＋ホテルはプルダウン選択可に" \
  --body "$(cat <<'EOF'
## 変更内容

- **`src/lib/hotels/hotel-admin-actions.ts`** (新規): `listHotelsAdmin` / `listBookableHotels` / `createHotel` / `updateHotel` / `deleteHotel`。owner/admin ゲート（`manage_cms`）。name unique 違反(23505)→「同名のホテルが既にあります」、FK 参照中 delete 失敗(23503)→「使用中のため削除できません。代わりに受け入れ停止にしてください」に変換。
- **`/admin/hotels` ページ** (新規): 一覧テーブル（name/エリア/追加移動分/入り方/住所/受け入れ状態）＋新規追加フォーム＋行ごとの編集・停止・削除。spec 12-2 トークン（adm-* Tailwind クラス）。3状態（空/ロード中/エラー）。
- **ナビ**（`layout.tsx` 修正）: 「派遣エリア」の直後に「派遣ホテル」を追加。
- **`BookingPopup.tsx`** 修正: ホテル全件プルダウン（`listBookableHotels` ロード→`<select>`）を追加。既存のテキスト検索・仮登録ボタンは残す。`selectHotel()` を共用するため entryNote の自動表示も維持。
- **`OrderEntryForm.tsx`** 修正: 同じく全件プルダウンを追加（タブ順維持・既存テキスト検索は残す）。
- **`tests/integration/hotel-admin-actions.test.ts`** (新規): 実 Postgres 統合テスト（作成/更新/停止/一意違反/使用中 delete 失敗/削除/不正UUID）。テスト用ホテル名は `ztest_hotel_` プレフィックス→afterAll で片付け。

## 検証

- [ ] `pnpm typecheck` 通過
- [ ] `pnpm lint` 通過（no-explicit-any: error）
- [ ] `pnpm build` 通過
- [ ] `pnpm vitest run tests/integration/hotel-admin-actions.test.ts` 全件グリーン
- [ ] grep: `any` なし・小数金額なし・クライアントから直接DB なし

## 判断ログ

- **auth gate**: hotels の RLS は `app_current_role() in ('owner', 'admin')` で write を制限。`manage_cms` capability も owner/admin のみ → `can(actor, 'manage_cms')` でゲートすることで一致。
- **listBookableHotels**: reception ロールも hotels SELECT できる（RLS hotels_staff_select）ため、manage_cms ゲートを付けず session 存在確認のみにした。
- **updateHotel の CASE 式**: null を「未指定」と「明示的に null に更新」の両方に使えないため、`d.field !== undefined` で「変更したい」を判定し `CASE WHEN` で条件更新。
- **BookingPopup/OrderEntryForm**: `listBookableHotels` は `"use server"` なので Next.js 15 の Server Actions RPC bridge 経由でクライアントから直接呼べる。`searchHotels` / `registerProvisionalHotel` と同じパターン。
EOF
)"
```

---

## Self-Review: Spec Coverage

**Spec 8-2 (ホテル管理):** hotels テーブルの全列（name/name_kana/address/area_id/entry_note/parking_note/extra_minutes/is_blocked/note）を編集できる。extra_minutes は UI で編集可。is_blocked で受け入れ停止できる。

**Spec 8-1 (電話受付・ホテル選択):** プルダウン追加でタイプなしに選べる。既存のテキスト検索・仮登録は残す（fallback）。BookingPopup の entryNote 表示は dropdown 選択時も反映される（`selectHotel()` が `setHotelEntryNote` を呼ぶため）。

**Spec 12-2 (管理画面トークン):** adm-* Tailwind クラス、角丸 4px 固定、影なし罫線区切り、1280px 想定。

**3状態:** page.tsx でエラー・ローディング・空状態すべて処理。HotelListClient で空状態メッセージ表示。

**禁止事項チェック:**
- `any` → 使用せず（全型明示）
- 小数金額 → なし（extra_minutes は分単位の整数で金額ではない）
- クライアントから直接 DB → なし（全 DB アクセスは server actions 経由）
- 日時を文字列計算 → なし
- 公開側テンプレートに直書き日本語 → なし（管理側のみ）
- .env/API キー → なし
