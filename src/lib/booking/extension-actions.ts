'use server';

/**
 * 当日オプション追加（延長）の Server Action（フェーズ15 / spec 3-4 L289・受入 L1100）。
 *
 * 完了条件「後続に間に合わない延長が拒否される」の実体。押した瞬間に canExtend で
 * 後続予約への影響を判定し、間に合わなければ**追加しない**。管理者は理由つきで上書き
 * できるが、物理的な重複は exclusion 制約が最終的に弾く（二重予約は不可）。
 *
 * 権限: 受付/管理（manage_reservations）。上書きは override_slot + 理由必須。
 * ※セラピスト本人がマイページから押す導線は、金額/時刻列の更新が 0012 の
 *   therapist guard トリガと衝突するため、実 update は staff/サーバ経路が担う
 *   （申請→受付が入れる運用）。live Auth 配線時に本人申請フローを精緻化する。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { canExtend } from '@/domain/booking/extension';
import {
  isOccupancyCheckError,
  isSlotTakenError,
  loadOptionSnapshots,
} from '@/lib/booking/holds';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface ExtensionResult {
  reservationId: string;
  version: number;
  newFreeAtISO: string;
  addedMinutes: number;
  addedAmount: number;
}

/** 延長を追加できる予約の状態（施術前後・施術中。完了/キャンセル済みは不可） */
const EXTENDABLE_STATUS = ['confirmed', 'enroute', 'in_service'] as const;

export async function addSameDayExtension(
  reservationId: string,
  optionId: string,
  opts?: { overrideReason?: string },
): Promise<ActionResult<ExtensionResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const actor = toActor(session);
  if (!can(actor, 'manage_reservations')) {
    return { ok: false, error: '予約を操作する権限がありません' };
  }

  const ids = z
    .object({ reservationId: z.string().uuid(), optionId: z.string().uuid() })
    .safeParse({ reservationId, optionId });
  if (!ids.success) return { ok: false, error: '無効なIDです' };

  const sql = getClient();

  try {
    // 対象予約 + セラピスト・占有・金額を取得
    const rows = await sql<{
      id: string;
      therapist_id: string;
      status: string;
      start_at: Date;
      end_at: Date;
      free_at: Date;
      total_amount: number;
      version: number;
    }[]>`
      select id, therapist_id, status::text, start_at, end_at, free_at,
             total_amount, version
      from reservations
      where id = ${ids.data.reservationId}::uuid
      limit 1
    `;
    const r = rows[0];
    if (!r) return { ok: false, error: '予約が見つかりません' };
    if (!EXTENDABLE_STATUS.includes(r.status as (typeof EXTENDABLE_STATUS)[number])) {
      return { ok: false, error: 'この予約は延長できない状態です' };
    }

    // 既に同じオプションが付いていないか
    const existing = await sql<{ n: number }[]>`
      select count(*)::int as n from reservation_options
      where reservation_id = ${r.id}::uuid and option_id = ${ids.data.optionId}::uuid
    `;
    if ((existing[0]?.n ?? 0) > 0) {
      return { ok: false, error: 'このオプションは既に追加されています' };
    }

    // オプションのスナップショット材料（対応可否・is_active/is_public を尊重）
    const optionRows = await loadOptionSnapshots(sql, {
      optionIds: [ids.data.optionId],
      therapistId: r.therapist_id,
    });
    const option = optionRows[0];
    if (!option) {
      return { ok: false, error: 'このオプションは追加できません（対象外）' };
    }
    const addedMinutes = option.duration_min;

    // 同一セラピストの直近後続予約の depart_at（占有下端）を取得
    const nextRows = await sql<{ depart_at: Date }[]>`
      select depart_at from reservations
      where therapist_id = ${r.therapist_id}::uuid
        and status in ('held', 'confirmed', 'enroute', 'in_service', 'done')
        and start_at > ${r.start_at}
      order by depart_at asc
      limit 1
    `;
    const nextDepartAt = nextRows[0]?.depart_at ?? null;

    // ★可否判定（純関数）
    const check = canExtend({
      currentFreeAt: r.free_at,
      addedMinutes,
      nextDepartAt,
    });

    const overrideReason = opts?.overrideReason?.trim() ?? '';
    let overridden = false;

    if (!check.ok) {
      // 後続に間に合わない。上書き（理由必須 + 権限）が無ければ拒否（完了条件）
      if (!overrideReason) {
        return {
          ok: false,
          error: `後続の予約に間に合わないため延長できません（あと${check.shortfallMin}分不足）`,
        };
      }
      if (!can(actor, 'override_slot', { kind: 'slot_override', reason: overrideReason })) {
        return { ok: false, error: '延長を上書きする権限がありません' };
      }
      // 上書きしても物理的な重複は exclusion が弾く（二重予約は作らない）
      overridden = true;
    }

    const newEndAt = new Date(r.end_at.getTime() + addedMinutes * 60_000);
    const newFreeAt = check.newFreeAt;
    const addedAmount = option.price;

    const result = await withUser(sql, session, async (tx) => {
      // オプションのスナップショット（L の計算に使った内容と一致 / spec 3-4）
      await tx`
        insert into reservation_options (
          reservation_id, option_id, price_snapshot, duration_snapshot,
          back_type_snapshot, back_value_snapshot
        ) values (
          ${r.id}::uuid, ${option.id}::uuid, ${option.price}, ${option.duration_min},
          ${option.back_type}::option_back_type, ${option.back_value}
        )
      `;

      // 占有を伸ばす（end_at/free_at を後ろへ）+ 金額加算 + 楽観ロック。
      // exclusion 制約 no_therapist_overlap が後続との重複を裁定する。
      const updated = await tx<{ version: number }[]>`
        update reservations
        set end_at = ${newEndAt},
            free_at = ${newFreeAt},
            total_amount = total_amount + ${addedAmount},
            version = version + 1
        where id = ${r.id}::uuid
          and version = ${r.version}
          and status = ${r.status}::reservation_status
        returning version
      `;
      if (!updated[0]) {
        throw new Error('version_conflict');
      }

      if (overridden) {
        await tx`
          insert into audit_logs (actor_user_id, action, entity, entity_id, after)
          values (
            ${session.userId}::uuid, 'override', 'reservation', ${r.id}::uuid,
            ${tx.json({ reason: overrideReason, kind: 'extension', optionId: option.id })}
          )
        `;
      }

      return { version: updated[0].version };
    });

    return {
      ok: true,
      data: {
        reservationId: r.id,
        version: result.version,
        newFreeAtISO: newFreeAt.toISOString(),
        addedMinutes,
        addedAmount,
      },
    };
  } catch (e) {
    if (isSlotTakenError(e) || isOccupancyCheckError(e)) {
      return {
        ok: false,
        error: '後続の予約と重なるため延長できません。時間を調整してください',
      };
    }
    if (e instanceof Error && e.message === 'version_conflict') {
      return {
        ok: false,
        error: '他の操作と競合しました。画面を更新してからやり直してください',
      };
    }
    console.error('addSameDayExtension failed:', e);
    return { ok: false, error: '延長の追加に失敗しました' };
  }
}
