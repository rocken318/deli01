'use server';

/**
 * セラピスト用マイページの Server Actions（spec 7-3・7-4）。
 *
 * 既存の actions.ts（owner/staff 向け）とは分け、therapist セッションで
 * queries.ts のコアを呼ぶ薄いラッパ。
 *
 * セッション解決: getTherapistDevSession（dev 限定）。
 * live Auth 配線後は getDefaultSessionProvider().getSession() に差し替える。
 * TODO(live Auth): src/lib/auth/ の live SessionProvider に差し替える。
 *
 * 電話番号: getTherapistTimelineCore は顧客電話番号を select しない（queries.ts 参照）。
 * 住所: 180分ゲート内のみ返し、返したら audit_logs に閲覧記録（queries.ts 参照）。
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { getClient } from '@/lib/db-client';
import { withUser } from '@/lib/auth/with-user';
import { getTherapistDevSession } from '@/lib/cms/dev-session';
import {
  advanceReservationStatusCore,
  getTherapistTimelineCore,
} from './queries';
import type {
  AdvanceTarget,
  TherapistTimelineItem,
} from './queries';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AdvanceStatusData {
  reservationId: string;
  version: number;
}

const advanceSchema = z.object({
  reservationId: z.string().uuid(),
  toStatus: z.enum(['enroute', 'in_service', 'done']),
});

const dateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, '日付は YYYY-MM-DD 形式です');

/**
 * セラピスト本人のタイムラインを取得する（当日または指定日）。
 * 電話番号は返さない。住所は 180分ゲート内のみ・監査記録あり。
 */
export async function getMyTimeline(
  dateISO: string,
  asSlug?: string,
): Promise<ActionResult<TherapistTimelineItem[]>> {
  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, error: '認証が必要です（セラピスト）' };

  const parsedDate = dateSchema.safeParse(dateISO);
  if (!parsedDate.success) return { ok: false, error: '日付の形式が不正です' };

  try {
    const outcome = await getTherapistTimelineCore(
      getClient(),
      session,
      parsedDate.data,
    );
    if (outcome.kind === 'forbidden') {
      return { ok: false, error: 'セラピスト本人のみ利用できます' };
    }
    return { ok: true, data: outcome.items };
  } catch (e) {
    console.error('getMyTimeline failed:', e);
    return { ok: false, error: '予定の取得に失敗しました' };
  }
}

/**
 * ステータスを1段前進させる（confirmed→enroute→in_service→done）。
 * therapist は自分の担当のみ・前進のみ（RLS + queries.ts でガード）。
 */
export async function advanceMyReservationStatus(
  reservationId: string,
  toStatus: AdvanceTarget,
  asSlug?: string,
): Promise<ActionResult<AdvanceStatusData>> {
  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, error: '認証が必要です（セラピスト）' };

  const parsed = advanceSchema.safeParse({ reservationId, toStatus });
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const outcome = await advanceReservationStatusCore(
      getClient(),
      session,
      parsed.data.reservationId,
      parsed.data.toStatus,
    );
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: { reservationId: outcome.reservationId, version: outcome.version },
        };
      case 'not_found':
        return { ok: false, error: '予約が見つかりません' };
      case 'invalid_transition':
        return {
          ok: false,
          error: 'この予約は現在の状態から進められません。画面を更新してください',
        };
      case 'conflict':
        return {
          ok: false,
          error: '他の端末で先に更新されました。画面を更新してください',
        };
    }
  } catch (e) {
    console.error('advanceMyReservationStatus failed:', e);
    return { ok: false, error: 'ステータスの更新に失敗しました' };
  }
}

/**
 * 緊急連絡を記録する（v1: audit_logs への記録のみ。実送信はフェーズ20）。
 * TODO(phase20): 管理者への実通知（LINE/メール等）を追加する。
 */
export async function recordEmergency(
  reservationId: string | null,
  message: string,
  asSlug?: string,
): Promise<ActionResult<{ loggedAt: string }>> {
  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, error: '認証が必要です（セラピスト）' };

  const msgParsed = z.string().min(1).max(500).safeParse(message);
  if (!msgParsed.success) return { ok: false, error: 'メッセージが不正です' };

  const idParsed = z.string().uuid().nullable().safeParse(reservationId);
  if (!idParsed.success) return { ok: false, error: '予約IDが不正です' };

  try {
    const sql = getClient();
    // withUser 経由（app_runtime 降格）で audit_logs へ追記する。特権接続で直接 insert
    // すると actor 詐称防止ポリシー（actor_user_id = app_current_user_id）が効かない
    // （reviewer S1 / 0001 の監査ポリシー）。actor はセッション本人に固定される。
    await withUser(sql, session, async (tx) => {
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after, occurred_at)
        values (
          ${session.userId}::uuid,
          'emergency',
          'reservation',
          ${idParsed.data}::uuid,
          ${tx.json({ message: msgParsed.data, therapistId: session.therapistId ?? null } as postgres.JSONValue)},
          now()
        )
      `;
    });
    return { ok: true, data: { loggedAt: new Date().toISOString() } };
  } catch (e) {
    console.error('recordEmergency failed:', e);
    return { ok: false, error: '緊急連絡の記録に失敗しました' };
  }
}
