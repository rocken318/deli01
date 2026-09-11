'use server';

/**
 * 方面グループ登録 Server Actions（設計 4.5）。
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

export interface DirectionGroupRow {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

const createSchema = z.object({
  name: z.string().min(1, '名称は必須です').max(100),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export async function listDirectionGroups(): Promise<ActionResult<DirectionGroupRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string; name: string; sort_order: number; is_active: boolean;
      }[]>`
        select id, name, sort_order, is_active
        from direction_groups
        order by sort_order asc, name asc
      `;
    });
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        sortOrder: r.sort_order,
        isActive: r.is_active,
      })),
    };
  } catch (e) {
    console.error('listDirectionGroups failed:', e);
    return { ok: false, error: '方面グループ一覧の取得に失敗しました' };
  }
}

export async function createDirectionGroup(
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
        insert into direction_groups (name, sort_order, is_active)
        values (${d.name}, ${d.sortOrder}, ${d.isActive})
        returning id
      `;
    });
    const id = rows[0]?.id;
    if (!id) return { ok: false, error: '登録に失敗しました' };
    revalidatePath('/admin/direction-groups');
    return { ok: true, data: { id } };
  } catch (e) {
    console.error('createDirectionGroup failed:', e);
    return { ok: false, error: '方面グループの登録に失敗しました' };
  }
}

export async function updateDirectionGroup(
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
        update direction_groups set
          name       = coalesce(${d.name ?? null}, name),
          sort_order = coalesce(${d.sortOrder ?? null}, sort_order),
          is_active  = coalesce(${d.isActive ?? null}, is_active)
        where id = ${d.id}::uuid
        returning id
      `;
    });
    if (rows.length === 0) return { ok: false, error: '方面グループが見つかりません' };
    revalidatePath('/admin/direction-groups');
    return { ok: true };
  } catch (e) {
    console.error('updateDirectionGroup failed:', e);
    return { ok: false, error: '方面グループの更新に失敗しました' };
  }
}

export async function deleteDirectionGroup(id: string): Promise<ActionResult> {
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
      return tx<{ id: string }[]>`
        delete from direction_groups where id = ${parsed.data}::uuid returning id
      `;
    });
    if (rows.length === 0) return { ok: false, error: '方面グループが見つかりません' };
    revalidatePath('/admin/direction-groups');
    return { ok: true };
  } catch (e) {
    console.error('deleteDirectionGroup failed:', e);
    return { ok: false, error: '方面グループの削除に失敗しました' };
  }
}
