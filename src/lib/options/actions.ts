'use server';

/**
 * オプション管理 Server Actions。
 * list = manage_reservations（受付も参照可）、write = manage_cms（owner/admin）。
 * 管理側 日本語直書き可。any 禁止。金額は整数。
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

export interface OptionRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  durationMin: number;
  backType: 'rate' | 'fixed';
  backValue: number;
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
}

const createSchema = z
  .object({
    name: z.string().min(1, 'オプション名は必須です').max(200),
    description: z.string().max(2000).optional(),
    price: z.number().int('価格は整数で入力してください').min(0),
    durationMin: z.number().int('所要時間は整数で入力してください').min(0).default(0),
    backType: z.enum(['rate', 'fixed']),
    backValue: z.number().int('バック値は整数で入力してください').min(0),
    isPublic: z.boolean().default(true),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .refine(
    (d) => d.backType !== 'rate' || d.backValue <= 100,
    { message: 'rate バックは 0〜100 の範囲で入力してください', path: ['backValue'] },
  );

const updateSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    price: z.number().int().min(0).optional(),
    durationMin: z.number().int().min(0).optional(),
    backType: z.enum(['rate', 'fixed']).optional(),
    backValue: z.number().int().min(0).optional(),
    isPublic: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine(
    (d) => {
      if (d.backType === 'rate' && d.backValue !== undefined) {
        return d.backValue <= 100;
      }
      return true;
    },
    { message: 'rate バックは 0〜100 の範囲で入力してください', path: ['backValue'] },
  );

export async function listOptionsAdmin(): Promise<ActionResult<OptionRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限が必要です' };
  }
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string;
        name: string;
        description: string | null;
        price: number;
        duration_min: number;
        back_type: 'rate' | 'fixed';
        back_value: number;
        is_public: boolean;
        is_active: boolean;
        sort_order: number;
      }[]>`
        select id, name, description, price, duration_min, back_type, back_value,
               is_public, is_active, sort_order
        from options
        order by sort_order asc, name asc
      `;
    });
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        price: r.price,
        durationMin: r.duration_min,
        backType: r.back_type,
        backValue: r.back_value,
        isPublic: r.is_public,
        isActive: r.is_active,
        sortOrder: r.sort_order,
      })),
    };
  } catch (e) {
    console.error('listOptionsAdmin failed:', e);
    return { ok: false, error: 'オプション一覧の取得に失敗しました' };
  }
}

export async function createOption(
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
        insert into options (
          name, description, price, duration_min, back_type, back_value,
          is_public, is_active, sort_order
        ) values (
          ${d.name}, ${d.description ?? null}, ${d.price}, ${d.durationMin},
          ${d.backType}::option_back_type, ${d.backValue},
          ${d.isPublic}, ${d.isActive}, ${d.sortOrder}
        )
        returning id
      `;
    });
    const id = rows[0]?.id;
    if (!id) return { ok: false, error: '登録に失敗しました' };
    revalidatePath('/admin/options');
    return { ok: true, data: { id } };
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === '23505') {
      return { ok: false, error: '同名のオプションが既にあります' };
    }
    console.error('createOption failed:', e);
    return { ok: false, error: 'オプションの登録に失敗しました' };
  }
}

export async function updateOption(
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
        update options set
          name         = coalesce(${d.name ?? null}, name),
          description  = ${d.description !== undefined ? d.description : sql`description`},
          price        = coalesce(${d.price ?? null}, price),
          duration_min = coalesce(${d.durationMin ?? null}, duration_min),
          back_type    = coalesce(${d.backType ? sql`${d.backType}::option_back_type` : null}, back_type),
          back_value   = coalesce(${d.backValue ?? null}, back_value),
          is_public    = coalesce(${d.isPublic ?? null}, is_public),
          is_active    = coalesce(${d.isActive ?? null}, is_active),
          sort_order   = coalesce(${d.sortOrder ?? null}, sort_order)
        where id = ${d.id}::uuid
        returning id
      `;
    });
    if (rows.length === 0) return { ok: false, error: 'オプションが見つかりません' };
    revalidatePath('/admin/options');
    return { ok: true };
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === '23505') {
      return { ok: false, error: '同名のオプションが既にあります' };
    }
    console.error('updateOption failed:', e);
    return { ok: false, error: 'オプションの更新に失敗しました' };
  }
}

export async function deleteOption(id: string): Promise<ActionResult> {
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
      return tx<{ id: string }[]>`delete from options where id = ${parsed.data}::uuid returning id`;
    });
    if (rows.length === 0) return { ok: false, error: 'オプションが見つかりません' };
    revalidatePath('/admin/options');
    return { ok: true };
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === '23503') {
      return { ok: false, error: '使用中のため削除できません。非公開/停止にしてください' };
    }
    console.error('deleteOption failed:', e);
    return { ok: false, error: 'オプションの削除に失敗しました' };
  }
}
