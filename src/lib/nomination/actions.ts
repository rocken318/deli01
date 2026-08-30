'use server';

/**
 * 指名NG管理 Server Actions（spec L808 / フェーズ16）。
 * customer_therapist_ng テーブルの CRUD。staff のみ。
 * DB guard トリガ（reservations_ng_guard）が全予約経路でNG組合せを拒否する前提で、
 * ここでは staff が登録・削除・一覧閲覧のみを行う（セラピスト本人には見せない）。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/points/actions';

const ngPairSchema = z.object({
  customerId: z.string().uuid(),
  therapistId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export interface NgPairRow {
  customerId: string;
  therapistId: string;
  customerName: string;
  therapistName: string;
  reason: string | null;
  createdAt: string;
}

/** 全NG組合せ一覧（staff のみ） */
export async function listNgPairs(): Promise<ActionResult<NgPairRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限がありません' };
  }

  try {
    const sql = getClient();
    const rows = await withUser(sql, session, (tx) => tx<
      {
        customer_id: string;
        therapist_id: string;
        customer_name: string;
        therapist_name: string;
        reason: string | null;
        created_at: Date;
      }[]
    >`
      select
        ng.customer_id,
        ng.therapist_id,
        cu.name  as customer_name,
        coalesce(er.published->>'name', th.slug) as therapist_name,
        ng.reason,
        ng.created_at
      from customer_therapist_ng ng
      join customers  cu on cu.id = ng.customer_id
      join therapists th on th.id = ng.therapist_id
      left join entity_records er on er.entity = 'therapist' and er.slug = th.slug
      order by ng.created_at desc
    `);
    return {
      ok: true,
      data: rows.map((r) => ({
        customerId: r.customer_id,
        therapistId: r.therapist_id,
        customerName: r.customer_name,
        therapistName: r.therapist_name,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
      })),
    };
  } catch (e) {
    console.error('listNgPairs failed:', e);
    return { ok: false, error: '指名NG一覧の取得に失敗しました' };
  }
}

/** NG組合せを追加（staff のみ） */
export async function addNgPair(
  input: z.infer<typeof ngPairSchema>,
): Promise<ActionResult<void>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限がありません' };
  }

  const parsed = ngPairSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const sql = getClient();
    await withUser(sql, session, (tx) => tx`
      insert into customer_therapist_ng (customer_id, therapist_id, reason, created_by)
      values (
        ${parsed.data.customerId}::uuid,
        ${parsed.data.therapistId}::uuid,
        ${parsed.data.reason ?? null},
        ${session.userId}::uuid
      )
      on conflict (customer_id, therapist_id) do nothing
    `);
    return { ok: true };
  } catch (e) {
    console.error('addNgPair failed:', e);
    return { ok: false, error: '指名NGの登録に失敗しました' };
  }
}

/** NG組合せを削除（staff のみ） */
export async function removeNgPair(input: {
  customerId: string;
  therapistId: string;
}): Promise<ActionResult<void>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限がありません' };
  }

  const parsed = z
    .object({ customerId: z.string().uuid(), therapistId: z.string().uuid() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const sql = getClient();
    await withUser(sql, session, (tx) => tx`
      delete from customer_therapist_ng
      where customer_id = ${parsed.data.customerId}::uuid
        and therapist_id = ${parsed.data.therapistId}::uuid
    `);
    return { ok: true };
  } catch (e) {
    console.error('removeNgPair failed:', e);
    return { ok: false, error: '指名NGの削除に失敗しました' };
  }
}
