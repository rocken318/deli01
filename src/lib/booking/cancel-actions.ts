'use server';

/**
 * 予約のキャンセル・無断キャンセルの Server Action（フェーズ15 / spec 6章 L647-648・11-2）。
 *
 * status を cancelled / noshow にすると exclusion の where 句から外れて枠が空く（0008）
 * ＝キャンセル待ちの契機になる。キャンセル料は cancellationFee（純関数）で算定して返すが、
 * 売上台帳への計上・バック配分はフェーズ17/18（ここでは金額算定と状態遷移まで）。
 * 権限: 受付/管理（manage_reservations）。顧客セルフ（URL+電話番号）導線は UI フェーズ。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import {
  cancellationFee,
  cancellationPercent,
  DEFAULT_CANCELLATION_POLICY,
  type CancellationTier,
} from '@/domain/booking/cancellation';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface CancelResult {
  reservationId: string;
  status: 'cancelled' | 'noshow';
  /** 請求率（%・明示用） */
  feePercent: number;
  /** キャンセル料（円・整数） */
  fee: number;
}

/** site_settings.cancellation_policy を CancellationTier[] に写す（未設定は雛形） */
async function loadCancellationPolicy(
  sql: ReturnType<typeof getClient>,
): Promise<readonly CancellationTier[]> {
  const rows = await sql<{ value: unknown }[]>`
    select value from site_settings where key = 'cancellation_policy' limit 1
  `;
  const raw = rows[0]?.value;
  if (!raw || typeof raw !== 'object') return DEFAULT_CANCELLATION_POLICY;
  const tiers = (raw as { tiers?: unknown }).tiers;
  if (!Array.isArray(tiers)) return DEFAULT_CANCELLATION_POLICY;
  const parsed: CancellationTier[] = [];
  for (const t of tiers) {
    if (
      t &&
      typeof t === 'object' &&
      typeof (t as { min_hours_before?: unknown }).min_hours_before === 'number' &&
      typeof (t as { percent?: unknown }).percent === 'number'
    ) {
      parsed.push({
        minHoursBefore: (t as { min_hours_before: number }).min_hours_before,
        percent: (t as { percent: number }).percent,
      });
    }
  }
  return parsed.length > 0 ? parsed : DEFAULT_CANCELLATION_POLICY;
}

const cancelSchema = z.object({
  reservationId: z.string().uuid(),
  kind: z.enum(['customer', 'shop', 'noshow']),
  reason: z.string().min(1, 'キャンセル理由を入力してください'),
});

export async function cancelReservation(
  reservationId: string,
  kind: 'customer' | 'shop' | 'noshow',
  reason: string,
): Promise<ActionResult<CancelResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const actor = toActor(session);
  if (!can(actor, 'manage_reservations')) {
    return { ok: false, error: '予約を操作する権限がありません' };
  }

  const parsed = cancelSchema.safeParse({ reservationId, kind, reason });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }
  const d = parsed.data;

  const sql = getClient();
  try {
    const rows = await sql<{
      id: string;
      status: string;
      start_at: Date;
      total_amount: number;
      version: number;
    }[]>`
      select id, status::text, start_at, total_amount, version
      from reservations where id = ${d.reservationId}::uuid limit 1
    `;
    const r = rows[0];
    if (!r) return { ok: false, error: '予約が見つかりません' };
    if (r.status === 'cancelled' || r.status === 'noshow') {
      return { ok: false, error: 'この予約は既にキャンセル済みです' };
    }

    const newStatus: 'cancelled' | 'noshow' = d.kind === 'noshow' ? 'noshow' : 'cancelled';

    const policy = await loadCancellationPolicy(sql);
    const hoursBeforeStart = (r.start_at.getTime() - Date.now()) / 3_600_000;
    const isNoShow = d.kind === 'noshow';
    const feePercent = cancellationPercent({ policy, hoursBeforeStart, isNoShow });
    const fee = cancellationFee({
      policy,
      hoursBeforeStart,
      baseAmount: r.total_amount,
      isNoShow,
    });

    await withUser(sql, session, async (tx) => {
      const updated = await tx<{ id: string }[]>`
        update reservations
        set status = ${newStatus}::reservation_status,
            cancelled_at = now(),
            cancel_reason = ${d.reason},
            cancel_kind = ${d.kind}::cancel_kind,
            version = version + 1
        where id = ${r.id}::uuid
          and version = ${r.version}
          and status = ${r.status}::reservation_status
        returning id
      `;
      if (!updated[0]) throw new Error('version_conflict');

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid, 'cancel', 'reservation', ${r.id}::uuid,
          ${tx.json({ kind: d.kind, status: newStatus, feePercent, fee, reason: d.reason })}
        )
      `;
    });

    return {
      ok: true,
      data: { reservationId: r.id, status: newStatus, feePercent, fee },
    };
  } catch (e) {
    if (e instanceof Error && e.message === 'version_conflict') {
      return {
        ok: false,
        error: '他の操作と競合しました。画面を更新してからやり直してください',
      };
    }
    console.error('cancelReservation failed:', e);
    return { ok: false, error: 'キャンセルに失敗しました' };
  }
}
