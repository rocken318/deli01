"use server";

/**
 * ホテル台帳 Server Actions（/admin/hotels）。
 *
 * - listHotelsAdmin / createHotel / updateHotel / deleteHotel は owner/admin のみ
 *   (can(actor, 'manage_cms'))。RLS hotels_owner_admin ポリシーと一致。
 * - listBookableHotels は reception 以上が使用（案内表・電話受付でホテルを選ぶ）。
 * - name unique 違反 (23505) → 「同名のホテルが既にあります」
 * - FK 参照中 delete 失敗 (23503) → 「使用中のため削除できません。代わりに受け入れ停止にしてください」
 * - 金額なし。extra_minutes は整数 (check >=0 は DB 側)。
 * - 0026: card_key_required / guest_charge_note / access_note / maps_url 追加。
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
  /** カードキー/フロント経由が必要か（0026） */
  cardKeyRequired: boolean;
  /** ゲストチャージ・同伴利用の注意（0026） */
  guestChargeNote: string | null;
  /** 止められた履歴・迎えの理由・入店注意（0026） */
  accessNote: string | null;
  /** Google Maps 経路URL（0026） */
  mapsUrl: string | null;
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
  /** 0026 */
  cardKeyRequired: z.boolean().optional().default(false),
  guestChargeNote: z.string().max(1000).optional(),
  accessNote: z.string().max(1000).optional(),
  mapsUrl: z.union([z.string().url("Google Maps URL の形式が正しくありません").max(2000), z.literal("")]).optional(),
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
  /** 0026 */
  cardKeyRequired: z.boolean().optional(),
  guestChargeNote: z.string().max(1000).nullable().optional(),
  accessNote: z.string().max(1000).nullable().optional(),
  mapsUrl: z.union([z.string().url("Google Maps URL の形式が正しくありません").max(2000), z.literal(""), z.null()]).optional(),
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
  card_key_required: boolean;
  guest_charge_note: string | null;
  access_note: string | null;
  maps_url: string | null;
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
          h.extra_minutes, h.is_blocked, h.note,
          h.card_key_required, h.guest_charge_note,
          h.access_note, h.maps_url
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
        cardKeyRequired: r.card_key_required,
        guestChargeNote: r.guest_charge_note,
        accessNote: r.access_note,
        mapsUrl: r.maps_url,
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
  input: z.input<typeof createHotelSchema>,
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
  // mapsUrl が空文字の場合は null として扱う
  const mapsUrlVal = d.mapsUrl === "" ? null : (d.mapsUrl ?? null);

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        insert into hotels (
          name, name_kana, address, area_id,
          entry_note, parking_note, extra_minutes, note,
          is_blocked,
          card_key_required, guest_charge_note, access_note, maps_url
        ) values (
          ${d.name},
          ${d.nameKana ?? null},
          ${d.address ?? null},
          ${d.areaId ?? null},
          ${d.entryNote ?? null},
          ${d.parkingNote ?? null},
          ${d.extraMinutes},
          ${d.note ?? null},
          false,
          ${d.cardKeyRequired},
          ${d.guestChargeNote ?? null},
          ${d.accessNote ?? null},
          ${mapsUrlVal}
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
      // postgres.js の sql(obj) helper でオブジェクトから SET 句を組み立てる。
      // undefined フィールドは含めない（据え置き）、null は明示的に null へ更新する。
      const updates: Record<string, unknown> = { updated_at: new Date() };
      if (d.name !== undefined) updates.name = d.name;
      if (d.nameKana !== undefined) updates.name_kana = d.nameKana;
      if (d.address !== undefined) updates.address = d.address;
      if (d.areaId !== undefined) updates.area_id = d.areaId;
      if (d.entryNote !== undefined) updates.entry_note = d.entryNote;
      if (d.parkingNote !== undefined) updates.parking_note = d.parkingNote;
      if (d.extraMinutes !== undefined) updates.extra_minutes = d.extraMinutes;
      if (d.isBlocked !== undefined) updates.is_blocked = d.isBlocked;
      if (d.note !== undefined) updates.note = d.note;
      // 0026
      if (d.cardKeyRequired !== undefined) updates.card_key_required = d.cardKeyRequired;
      if (d.guestChargeNote !== undefined) updates.guest_charge_note = d.guestChargeNote;
      if (d.accessNote !== undefined) updates.access_note = d.accessNote;
      if (d.mapsUrl !== undefined) updates.maps_url = d.mapsUrl === "" ? null : d.mapsUrl;

      await tx`update hotels set ${tx(updates)} where id = ${d.id}::uuid`;
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

/** ホテルを削除する（owner/admin）。予約から参照中なら事前チェックで拒否する。 */
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
    const result = await withUser(sql, session, async (tx) => {
      // 予約・住所から参照中か確認（ON DELETE SET NULL のため FK エラーが出ない）
      const refs = await tx<{ cnt: string }[]>`
        select (
          (select count(*) from reservations where hotel_id = ${id}::uuid)
          +
          (select count(*) from addresses where hotel_id = ${id}::uuid)
        ) as cnt
      `;
      const refCount = parseInt(refs[0]?.cnt ?? "0", 10);
      if (refCount > 0) {
        return { blocked: true } as const;
      }
      await tx`delete from hotels where id = ${id}::uuid`;
      return { blocked: false } as const;
    });
    if (result.blocked) {
      return { ok: false, error: "使用中のため削除できません。代わりに「受け入れ停止」にしてください" };
    }
    revalidatePath("/admin/hotels");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: pgErrToMessage(e) };
  }
}


