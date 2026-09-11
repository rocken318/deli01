'use server';

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';
import { isSlotTakenError } from '@/lib/booking/holds';
import type { ActionResult } from '@/lib/booking/extension-actions';

export interface AssignableTherapist {
  id: string;
  slug: string;
  name: string;
  busy: boolean;
}

export async function listAssignableTherapists(
  reservationId: string,
): Promise<ActionResult<AssignableTherapist[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  const actor = toActor(session);
  if (!can(actor, 'manage_reservations')) return { ok: false, error: '権限がありません' };

  const idParsed = z.string().uuid().safeParse(reservationId);
  if (!idParsed.success) return { ok: false, error: '無効なIDです' };

  const sql = getClient();

  try {
    const data = await withUser(sql, session, async (tx) => {
      // Get the reservation's time window
      const resRows = await tx<{ depart_at: Date; free_at: Date }[]>`
        select depart_at, free_at from reservations
        where id = ${idParsed.data}::uuid
        limit 1
      `;
      const res = resRows[0];
      if (!res) throw new Error('not_found');

      // Get all active therapists
      const therapists = await tx<{ id: string; slug: string; name: string | null }[]>`
        select t.id, t.slug,
               coalesce(er.published->>'name', er.draft->>'name', t.slug) as name
        from therapists t
        left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
        where t.status = 'active'
        order by t.display_order asc
      `;

      // For each therapist, check if they have an overlapping reservation (excluding the current one)
      const result: AssignableTherapist[] = [];
      for (const t of therapists) {
        const overlapRows = await tx<{ n: number }[]>`
          select count(*)::int as n from reservations
          where therapist_id = ${t.id}::uuid
            and id <> ${idParsed.data}::uuid
            and status not in ('cancelled', 'noshow')
            and depart_at < ${res.free_at}
            and free_at > ${res.depart_at}
        `;
        const busy = (overlapRows[0]?.n ?? 0) > 0;
        result.push({ id: t.id, slug: t.slug, name: t.name ?? t.slug, busy });
      }
      return result;
    });

    return { ok: true, data };
  } catch (e) {
    if (e instanceof Error && e.message === 'not_found') {
      return { ok: false, error: '予約が見つかりません' };
    }
    console.error('listAssignableTherapists failed:', e);
    return { ok: false, error: 'セラピスト一覧の取得に失敗しました' };
  }
}

export async function changeReservationTherapist(params: {
  reservationId: string;
  therapistId: string;
  overrideReason?: string;
}): Promise<ActionResult<{ version: number }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  const actor = toActor(session);
  if (!can(actor, 'manage_reservations')) return { ok: false, error: '権限がありません' };

  const ids = z
    .object({ reservationId: z.string().uuid(), therapistId: z.string().uuid() })
    .safeParse({ reservationId: params.reservationId, therapistId: params.therapistId });
  if (!ids.success) return { ok: false, error: '無効なIDです' };

  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      // Fetch current reservation
      const rows = await tx<{ therapist_id: string; status: string; version: number }[]>`
        select therapist_id, status::text, version from reservations
        where id = ${ids.data.reservationId}::uuid
        limit 1
      `;
      const current = rows[0];
      if (!current) throw new Error('not_found');

      const CHANGEABLE = new Set(['held', 'confirmed', 'enroute', 'in_service']);
      if (!CHANGEABLE.has(current.status)) {
        throw new Error('status_error');
      }

      const oldTherapistId = current.therapist_id;

      // Update reservation therapist_id with optimistic lock
      const updated = await tx<{ version: number }[]>`
        update reservations
        set therapist_id = ${ids.data.therapistId}::uuid,
            version = version + 1,
            updated_at = now()
        where id = ${ids.data.reservationId}::uuid
          and version = ${current.version}
        returning version
      `;
      if (!updated[0]) throw new Error('version_conflict');

      // Sync dispatch_legs
      await tx`
        update dispatch_legs
        set therapist_id = ${ids.data.therapistId}::uuid,
            updated_at = now()
        where reservation_id = ${ids.data.reservationId}::uuid
      `;

      // Audit log
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, before, after)
        values (
          ${session.userId}::uuid,
          'therapist_change',
          'reservation',
          ${ids.data.reservationId}::uuid,
          ${tx.json({ therapistId: oldTherapistId })},
          ${tx.json({ therapistId: ids.data.therapistId, reason: params.overrideReason ?? null })}
        )
      `;

      return { version: updated[0].version };
    });

    revalidatePath('/admin/reservation-list');
    revalidatePath('/admin/dispatch-board');
    revalidatePath('/admin/annai');

    return { ok: true, data: result };
  } catch (e) {
    if (isSlotTakenError(e)) {
      return { ok: false, error: '変更先のセラピストは同じ時間に別の予約があります' };
    }
    if (e instanceof Error) {
      if (e.message === 'status_error') {
        return { ok: false, error: '完了/取消済みの予約は担当を変更できません' };
      }
      if (e.message === 'not_found') {
        return { ok: false, error: '予約が見つかりません' };
      }
      if (e.message === 'version_conflict') {
        return { ok: false, error: '他の操作と競合しました。画面を更新してからやり直してください' };
      }
    }
    console.error('changeReservationTherapist failed:', e);
    return { ok: false, error: '担当変更に失敗しました' };
  }
}
