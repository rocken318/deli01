'use server';

/**
 * セラピスト NG条件メモの取得/更新 Server Actions。
 * list = manage_reservations（受付・案内表・配車で参照）。
 * write = manage_cms（owner/admin のみ）。
 * 管理側 日本語直書き可。any 禁止。金額は扱わない。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import type { ActionResult } from '@/lib/drivers/actions';

export interface TherapistNgNoteRow {
  therapistId: string;
  slug: string;
  name: string;
  ngNote: string | null;
}

const setNgNoteSchema = z.object({
  therapistId: z.string().uuid(),
  ngNote: z.string().max(1000, 'NGメモは1000字以内で入力してください').optional(),
});

/**
 * アクティブなセラピスト一覧と各自のNGメモを返す。
 * manage_reservations 権限が必要（受付・案内表・配車で使用）。
 */
export async function listTherapistNgNotes(): Promise<ActionResult<TherapistNgNoteRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限がありません' };
  }

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string; slug: string; name: string | null; ng_note: string | null }[]>`
        select
          t.id,
          t.slug,
          coalesce(er.published->>'name', er.draft->>'name', t.slug) as name,
          t.ng_note
        from therapists t
        left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
        where t.status = 'active'
        order by t.display_order asc, t.slug asc
      `;
    });

    return {
      ok: true,
      data: rows.map((r) => ({
        therapistId: r.id,
        slug: r.slug,
        name: r.name ?? r.slug,
        ngNote: r.ng_note,
      })),
    };
  } catch (e) {
    console.error('listTherapistNgNotes failed:', e);
    return { ok: false, error: 'NGメモ一覧の取得に失敗しました' };
  }
}

/**
 * セラピストのNGメモを更新する。
 * manage_cms 権限（owner/admin）が必要。
 * 空文字は null に変換する。1000字超はエラー。
 */
export async function setTherapistNgNote(input: {
  therapistId: string;
  ngNote: string | null | undefined;
}): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) {
    return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  }

  const parsed = setNgNoteSchema.safeParse({
    therapistId: input.therapistId,
    ngNote: input.ngNote ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  // 空文字 → null
  const rawNote = parsed.data.ngNote;
  const noteValue: string | null =
    rawNote === undefined || rawNote === '' ? null : rawNote;

  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update therapists
        set ng_note = ${noteValue}
        where id = ${parsed.data.therapistId}::uuid
        returning id
      `;
    });

    if (rows.length === 0) return { ok: false, error: 'セラピストが見つかりません' };

    revalidatePath('/admin/therapists');
    revalidatePath('/admin/annai');
    revalidatePath('/admin/dispatch-board');
    revalidatePath('/admin/reservation-list');
    revalidatePath('/admin/orders');

    return { ok: true };
  } catch (e) {
    console.error('setTherapistNgNote failed:', e);
    return { ok: false, error: 'NGメモの更新に失敗しました' };
  }
}
