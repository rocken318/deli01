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
