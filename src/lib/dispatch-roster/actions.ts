'use server';

/**
 * 配車名簿 Server Actions（spec 7-1 運用レイヤー）。
 *
 * taxi_companies: タクシー会社名簿の CRUD（write = owner/admin のみ）。
 * driver_messages: ドライバー合同伝言板（post/list = staff、delete = owner/admin）。
 *
 * 管理側 UI のため日本語文言を直書きしてよい（spec 13-1 は公開側のみ）。
 * 金額を扱わない。any 禁止。クライアントから直接 DB は触らない。
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

export interface TaxiCompanyRow {
  id: string;
  name: string;
  phone: string | null;
  shiftNote: string | null;
  note: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface DriverMessageRow {
  id: string;
  body: string;
  createdBy: string | null;
  createdAt: string;
}

const createTaxiSchema = z.object({
  name: z.string().min(1, '会社名は必須です').max(200),
  phone: z.string().max(50).optional(),
  shiftNote: z.string().max(500).optional(),
  note: z.string().max(1000).optional(),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

const updateTaxiSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  phone: z.string().max(50).nullable().optional(),
  shiftNote: z.string().max(500).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

const postMessageSchema = z.object({
  body: z.string().min(1, '本文は必須です').max(2000),
});

export async function listTaxiCompanies(): Promise<ActionResult<TaxiCompanyRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string;
        name: string;
        phone: string | null;
        shift_note: string | null;
        note: string | null;
        sort_order: number;
        is_active: boolean;
      }[]>`
        select id, name, phone, shift_note, note, sort_order, is_active
        from taxi_companies
        order by sort_order asc, name asc
      `;
    });
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        shiftNote: r.shift_note,
        note: r.note,
        sortOrder: r.sort_order,
        isActive: r.is_active,
      })),
    };
  } catch (e) {
    console.error('listTaxiCompanies failed:', e);
    return { ok: false, error: 'タクシー会社一覧の取得に失敗しました' };
  }
}

export async function createTaxiCompany(
  input: z.input<typeof createTaxiSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) {
    return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  }

  const parsed = createTaxiSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }
  const d = parsed.data;

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        insert into taxi_companies (name, phone, shift_note, note, sort_order, is_active)
        values (
          ${d.name},
          ${d.phone ?? null},
          ${d.shiftNote ?? null},
          ${d.note ?? null},
          ${d.sortOrder},
          ${d.isActive}
        )
        returning id
      `;
    });
    const id = rows[0]?.id;
    if (!id) return { ok: false, error: '登録に失敗しました' };
    revalidatePath('/admin/dispatch-roster');
    return { ok: true, data: { id } };
  } catch (e) {
    console.error('createTaxiCompany failed:', e);
    return { ok: false, error: 'タクシー会社の登録に失敗しました' };
  }
}

export async function updateTaxiCompany(
  input: z.input<typeof updateTaxiSchema>,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) {
    return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  }

  const parsed = updateTaxiSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }
  const d = parsed.data;

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update taxi_companies set
          name       = coalesce(${d.name ?? null}, name),
          phone      = ${d.phone !== undefined ? d.phone : sql`phone`},
          shift_note = ${d.shiftNote !== undefined ? d.shiftNote : sql`shift_note`},
          note       = ${d.note !== undefined ? d.note : sql`note`},
          sort_order = coalesce(${d.sortOrder ?? null}, sort_order),
          is_active  = coalesce(${d.isActive ?? null}, is_active)
        where id = ${d.id}::uuid
        returning id
      `;
    });
    if (rows.length === 0) return { ok: false, error: 'タクシー会社が見つかりません' };
    revalidatePath('/admin/dispatch-roster');
    return { ok: true };
  } catch (e) {
    console.error('updateTaxiCompany failed:', e);
    return { ok: false, error: 'タクシー会社の更新に失敗しました' };
  }
}

export async function deleteTaxiCompany(id: string): Promise<ActionResult> {
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
        delete from taxi_companies where id = ${parsed.data}::uuid returning id
      `;
    });
    if (rows.length === 0) return { ok: false, error: 'タクシー会社が見つかりません' };
    revalidatePath('/admin/dispatch-roster');
    return { ok: true };
  } catch (e) {
    console.error('deleteTaxiCompany failed:', e);
    return { ok: false, error: 'タクシー会社の削除に失敗しました' };
  }
}

export async function listDriverMessages(
  limit = 50,
): Promise<ActionResult<DriverMessageRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string;
        body: string;
        created_by: string | null;
        created_at: Date;
      }[]>`
        select id, body, created_by, created_at
        from driver_messages
        order by created_at desc
        limit ${limit}
      `;
    });
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        body: r.body,
        createdBy: r.created_by,
        createdAt: r.created_at.toISOString(),
      })),
    };
  } catch (e) {
    console.error('listDriverMessages failed:', e);
    return { ok: false, error: '伝言板の取得に失敗しました' };
  }
}

export async function postDriverMessage(
  input: z.input<typeof postMessageSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }

  const parsed = postMessageSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        insert into driver_messages (body, created_by)
        values (${parsed.data.body}, ${session.userId}::uuid)
        returning id
      `;
    });
    const id = rows[0]?.id;
    if (!id) return { ok: false, error: '投稿に失敗しました' };
    revalidatePath('/admin/dispatch-roster');
    return { ok: true, data: { id } };
  } catch (e) {
    console.error('postDriverMessage failed:', e);
    return { ok: false, error: '伝言の投稿に失敗しました' };
  }
}

export async function deleteDriverMessage(id: string): Promise<ActionResult> {
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
        delete from driver_messages where id = ${parsed.data}::uuid returning id
      `;
    });
    if (rows.length === 0) return { ok: false, error: '伝言が見つかりません' };
    revalidatePath('/admin/dispatch-roster');
    return { ok: true };
  } catch (e) {
    console.error('deleteDriverMessage failed:', e);
    return { ok: false, error: '伝言の削除に失敗しました' };
  }
}