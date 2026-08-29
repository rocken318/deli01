'use server';

/**
 * フェーズ14 配車ボード・セラピストマイページ Server Actions（spec 7-1・7-3・7-4）。
 *
 * 実体は queries.ts（Session 注入型のコア）。ここは
 *   getDevSession → Zod 検証 → コア呼び出し → ActionResult 変換
 * の薄いラッパで、後続 admin-ui はこのファイルの関数に UI を載せる。
 *
 * 個人情報の経路分離（spec 7-3・13-3）:
 * - getTherapistTimeline: therapist 本人専用。電話番号を一切返さない。
 *   住所は 180分ゲート内のみ・返したら閲覧監査（詳細は queries.ts）。
 * - getDispatchBoard: staff（owner/admin/reception）専用。タップ発信用に
 *   電話番号を含む（spec 7-1 L692）。
 *
 * 生の Postgres エラー（RLS 拒否・0012 トリガの 42501 等）は画面に出さず、
 * 汎用文言に変換する（管理側文言のため直書き日本語は許容 / spec 13-1 は公開側）。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import {
  advanceReservationStatusCore,
  getDispatchBoardCore,
  getTherapistTimelineCore,
} from './queries';
import type {
  AdvanceTarget,
  DispatchBoardItem,
  TherapistTimelineItem,
} from './queries';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const advanceSchema = z.object({
  reservationId: z.string().uuid(),
  toStatus: z.enum(['enroute', 'in_service', 'done']),
});

const dateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, '日付は YYYY-MM-DD 形式です');

export interface AdvanceStatusData {
  reservationId: string;
  /** 楽観ロックの新 version */
  version: number;
}

/**
 * ステータスをワンタップで1段進める（confirmed→enroute→in_service→done の
 * 隣接前進のみ）。0 行更新 = 競合（他端末が先に操作）。
 */
export async function advanceReservationStatus(
  reservationId: string,
  toStatus: AdvanceTarget,
): Promise<ActionResult<AdvanceStatusData>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

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
    // RLS 拒否・トリガ 42501 等の生 Postgres エラーは画面に出さない
    console.error('advanceReservationStatus failed:', e);
    return { ok: false, error: 'ステータスの更新に失敗しました' };
  }
}

/**
 * ログイン中セラピスト自身の当日タイムライン（移動→施術→移動）。
 * 電話番号を含まない（spec 7-3 の列制御）。
 */
export async function getTherapistTimeline(
  dateISO: string,
): Promise<ActionResult<TherapistTimelineItem[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

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
    console.error('getTherapistTimeline failed:', e);
    return { ok: false, error: '予定の取得に失敗しました' };
  }
}

/**
 * 配車ボード（owner/admin/reception）。当日の全セラピストの予約を
 * 3ブロック（移動→施術→移動）描画に必要な時刻内訳・遅延/退出アラート・
 * 初回フラグ・タップ発信用電話番号つきで返す。
 */
export async function getDispatchBoard(
  dateISO: string,
): Promise<ActionResult<DispatchBoardItem[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsedDate = dateSchema.safeParse(dateISO);
  if (!parsedDate.success) return { ok: false, error: '日付の形式が不正です' };

  try {
    const outcome = await getDispatchBoardCore(getClient(), session, parsedDate.data);
    if (outcome.kind === 'forbidden') {
      return { ok: false, error: '配車ボードは運営権限のみ利用できます' };
    }
    return { ok: true, data: outcome.items };
  } catch (e) {
    console.error('getDispatchBoard failed:', e);
    return { ok: false, error: '配車ボードの取得に失敗しました' };
  }
}
