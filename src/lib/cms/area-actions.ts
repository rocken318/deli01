"use server";

/**
 * 派遣エリア台帳の Server Actions（/admin/areas）。
 *
 * - 全アクションは owner/admin のみ（can(actor, 'manage_cms')）+ audit_logs 記録
 * - withUser() 経由で RLS を有効にして実行する
 * - center は ST_SetSRID(ST_MakePoint(lon, lat), 4326) で書く
 *   取り出しは ST_X(center::geometry) / ST_Y(center::geometry)
 * - is_active=true のエリアが出勤登録の対応エリアチェックに自動で出る（spec 3-3）
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import type { ActionResult } from "@/lib/cms/actions";

// ActionResult を再エクスポート（クライアント側で import しやすいように）
export type { ActionResult };

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export interface DispatchArea {
  id: string;
  name: string;
  kind: "ward" | "city" | "station";
  sortOrder: number;
  isActive: boolean;
  lon: number | null;
  lat: number | null;
  /** エリア別の車交通費（税別・整数円・1000円単位）。徒歩圏は 0 / 発注者決定 2026-09-04 */
  transportFee: number;
}

// ---------------------------------------------------------------------------
// バリデーションスキーマ
// ---------------------------------------------------------------------------

const kindSchema = z.enum(["ward", "city", "station"]);
const uuidSchema = z.string().uuid();

/** 仙台中心の既定座標 */
const DEFAULT_LON = 140.8721;
const DEFAULT_LAT = 38.2688;

const createAreaSchema = z.object({
  name: z.string().min(1, "エリア名は1文字以上必要です").max(100, "エリア名は100文字以内にしてください"),
  kind: kindSchema,
  lon: z.number().finite().optional(),
  lat: z.number().finite().optional(),
});

const renameAreaSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1, "エリア名は1文字以上必要です").max(100, "エリア名は100文字以内にしてください"),
});

const setActiveSchema = z.object({
  id: uuidSchema,
  isActive: z.boolean(),
});

const setTransportFeeSchema = z.object({
  id: uuidSchema,
  // 税別・整数円・1000円単位（発注者決定 2026-09-04）。0（拠点/徒歩圏）も可。
  transportFee: z
    .number()
    .int("交通費は整数で入力してください")
    .min(0, "交通費は0以上で入力してください")
    .max(100000, "交通費が大きすぎます")
    .refine((v) => v % 1000 === 0, "交通費は1000円単位で入力してください"),
});

// ---------------------------------------------------------------------------
// 一覧
// ---------------------------------------------------------------------------

interface AreaRow {
  id: string;
  name: string;
  kind: "ward" | "city" | "station";
  sort_order: number;
  is_active: boolean;
  lon: number | null;
  lat: number | null;
  transport_fee: number;
}

/** 派遣エリア一覧を取得する（owner/admin のみ）。sort_order → name asc 順。 */
export async function listDispatchAreas(): Promise<DispatchArea[]> {
  const session = await getDevSession();
  if (!session) return [];
  if (!can(toActor(session), "manage_cms")) return [];

  const sql = getClient();

  const rows = await withUser(sql, session, async (tx) => {
    return tx<AreaRow[]>`
      select
        id,
        name,
        kind,
        sort_order,
        is_active,
        ST_X(center::geometry) as lon,
        ST_Y(center::geometry) as lat,
        transport_fee
      from areas
      order by sort_order asc, name asc
    `;
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    sortOrder: r.sort_order,
    isActive: r.is_active,
    lon: r.lon,
    lat: r.lat,
    transportFee: r.transport_fee,
  }));
}

// ---------------------------------------------------------------------------
// 追加
// ---------------------------------------------------------------------------

/**
 * 派遣エリアを追加する（owner/admin のみ）。
 * lon/lat 未指定なら仙台中心の既定座標を使用する。
 * sort_order は現在の最大値 + 10。
 */
export async function createDispatchArea(input: {
  name: string;
  kind: string;
  lon?: number;
  lat?: number;
}): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = createAreaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const data = parsed.data;
  const lon = data.lon ?? DEFAULT_LON;
  const lat = data.lat ?? DEFAULT_LAT;

  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      // 現在の最大 sort_order を取得
      const maxRows = await tx<{ max_sort: number | null }[]>`
        select max(sort_order) as max_sort from areas
      `;
      const maxSort = maxRows[0]?.max_sort ?? 0;
      const sort = maxSort + 10;

      const rows = await tx<{ id: string }[]>`
        insert into areas (name, kind, center, sort_order)
        values (
          ${data.name},
          ${data.kind},
          ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326),
          ${sort}
        )
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error("insert failed");

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid,
          'create',
          'area',
          ${row.id}::uuid,
          ${tx.json({ name: data.name, kind: data.kind, lon, lat, sort })}
        )
      `;

      return { id: row.id };
    });

    revalidatePath("/admin/areas");
    revalidatePath("/admin/shifts");
    return { ok: true, data: result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    if (msg.includes("areas_name_key") || msg.includes("unique") && msg.toLowerCase().includes("name")) {
      return { ok: false, error: "同名のエリアが既にあります" };
    }
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// 有効/無効切替
// ---------------------------------------------------------------------------

/**
 * エリアの is_active を切り替える（owner/admin のみ）。
 * 無効化したエリアは出勤登録の対応エリアチェックから消える（spec 3-3）。
 */
export async function setDispatchAreaActive(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = setActiveSchema.safeParse({ id, isActive });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update areas set is_active = ${isActive} where id = ${id}::uuid returning id
      `;
      if (!rows[0]) throw new Error("対象のエリアが見つかりません");

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid,
          'update',
          'area',
          ${id}::uuid,
          ${tx.json({ isActive })}
        )
      `;
    });

    revalidatePath("/admin/areas");
    revalidatePath("/admin/shifts");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// 交通費（エリア別・税別・1000円単位）
// ---------------------------------------------------------------------------

/**
 * エリアの車交通費を設定する（owner/admin のみ / 発注者決定 2026-09-04）。
 * 税別・整数円・1000円単位。徒歩圏は 0。予約時に reservations.transport_fee へスナップショット。
 * 交通費は店がドライバーへ支払う経費で、売上・バックには入れない（会計方針と対）。
 */
export async function setDispatchAreaTransportFee(
  id: string,
  transportFee: number,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = setTransportFeeSchema.safeParse({ id, transportFee });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string; transport_fee: number }[]>`
        select id, transport_fee from areas where id = ${parsed.data.id}::uuid
      `;
      const before = rows[0];
      if (!before) throw new Error("対象のエリアが見つかりません");

      await tx`
        update areas set transport_fee = ${parsed.data.transportFee}
        where id = ${parsed.data.id}::uuid
      `;

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, before, after)
        values (
          ${session.userId}::uuid,
          'update',
          'area',
          ${parsed.data.id}::uuid,
          ${tx.json({ transportFee: before.transport_fee })},
          ${tx.json({ transportFee: parsed.data.transportFee })}
        )
      `;
    });

    revalidatePath("/admin/areas");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// 改名
// ---------------------------------------------------------------------------

/**
 * エリア名を変更する（owner/admin のみ）。
 * name は unique 制約があるため重複はエラーで返す。
 */
export async function renameDispatchArea(
  id: string,
  name: string,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = renameAreaSchema.safeParse({ id, name });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }
  const data = parsed.data;

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string; name: string }[]>`
        select id, name from areas where id = ${data.id}::uuid
      `;
      const before = rows[0];
      if (!before) throw new Error("対象のエリアが見つかりません");

      await tx`
        update areas set name = ${data.name} where id = ${data.id}::uuid
      `;

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, before, after)
        values (
          ${session.userId}::uuid,
          'update',
          'area',
          ${data.id}::uuid,
          ${tx.json({ name: before.name })},
          ${tx.json({ name: data.name })}
        )
      `;
    });

    revalidatePath("/admin/areas");
    revalidatePath("/admin/shifts");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    if (msg.includes("areas_name_key") || (msg.includes("unique") && msg.toLowerCase().includes("name"))) {
      return { ok: false, error: "同名のエリアが既にあります" };
    }
    return { ok: false, error: msg };
  }
}
