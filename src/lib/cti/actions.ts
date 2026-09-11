'use server';

/**
 * CTI Server Actions（フェーズ14 / spec 22章）。
 * 管理側 日本語直書き可。any 禁止。
 *
 * - getRecentIncomingCalls: 直近 sinceSeconds 以内の着信一覧
 * - markCtiHandled:         着信を対応済みにする（set-once）
 * - simulateIncoming:       模擬着信（デモ/テスト用。回線無しで動作確認可能）
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** CTI 着信イベントの公開型 */
export interface CtiEvent {
  id: string;
  phone: string;
  customerId: string | null;
  matchedName: string | null;
  handled: boolean;
  occurredAtISO: string;
}

const phoneSchema = z.string().regex(/^0[0-9]{9,10}$/u, '電話番号の形式が不正です');

/**
 * 直近 sinceSeconds 秒以内の cti_events を新しい順で返す（上限20件）。
 * manage_reservations 権限（owner/admin/reception）。
 */
export async function getRecentIncomingCalls(
  sinceSeconds = 120,
): Promise<ActionResult<CtiEvent[]>> {
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
        phone: string;
        customer_id: string | null;
        matched_name: string | null;
        handled_by: string | null;
        occurred_at: Date;
      }[]>`
        select id::text,
               phone,
               customer_id::text,
               matched_name,
               handled_by::text,
               occurred_at
        from cti_events
        where occurred_at >= now() - (${sinceSeconds} * interval '1 second')
        order by occurred_at desc
        limit 20
      `;
    });

    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        customerId: r.customer_id,
        matchedName: r.matched_name,
        handled: r.handled_by !== null,
        occurredAtISO: r.occurred_at.toISOString(),
      })),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}

/**
 * 着信イベントを対応済みにする（handled_by / handled_at を set-once）。
 * 既に handled なら no-op で ok=true。
 * manage_reservations 権限（owner/admin/reception）。
 */
export async function markCtiHandled(
  id: string,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }

  // id は bigint（generated always as identity）なのでテキスト数値として受け取る
  const parsedId = z.string().regex(/^\d+$/, '無効なIDです').safeParse(id);
  if (!parsedId.success) return { ok: false, error: '無効なIDです' };

  const sql = getClient();
  try {
    await withUser(sql, session, async (tx) => {
      // handled_by が null の行のみ更新（set-once）
      await tx`
        update cti_events
        set handled_by = ${session.userId}::uuid,
            handled_at = now()
        where id = ${parsedId.data}::bigint
          and handled_by is null
      `;
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}

/**
 * 模擬着信（デモ/テスト用）。
 * /api/cti/incoming と同じロジック（顧客引き当て→cti_events insert）を
 * アクション層で再実装。owner/admin/reception のみ実行可能。
 */
export async function simulateIncoming(
  phone: string,
): Promise<ActionResult<{ id: string; matched: boolean }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }

  const parsed = phoneSchema.safeParse(phone);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? '電話番号が不正です' };
  }
  const validPhone = parsed.data;

  const sql = getClient();
  try {
    // 顧客引き当て（特権接続で行う。withUser の外で OK = webhook と同経路）
    const customers = await sql<{ id: string; name: string }[]>`
      select id, name from customers where phone = ${validPhone} limit 1
    `;
    const customer = customers[0] ?? null;

    // cti_events に挿入（withUser でセッションを紐付ける）
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        insert into cti_events (phone, customer_id, matched_name)
        values (
          ${validPhone},
          ${customer?.id ?? null}::uuid,
          ${customer?.name ?? null}
        )
        returning id::text
      `;
    });
    const row = rows[0];
    if (!row) throw new Error('cti_events への挿入に失敗しました');

    return { ok: true, data: { id: row.id, matched: customer !== null } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}
