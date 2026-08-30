'use server';

/**
 * フェーズ16 引き継ぎメモ Server Actions（spec 9章 L810-814）。
 *
 * 実体は queries.ts（Session 注入型のコア）。行スコープは RLS（0014）が正:
 * 次回予約の担当セラピストにだけ表示・他セラピスト/顧客本人には見せない
 * （受入 L1123）。
 *
 * セッション解決:
 * - addHandoverNote / getHandoverNotesForNextVisit: therapist 本人
 *   （getTherapistDevSession。live Auth 配線までの dev 経路 / 0012 (g) と同じ）
 * - listHandoverNotes: staff（電話受付が引き継ぎを確認する用）
 *
 * UI 側の義務（admin-ui 後続）: 入力欄に**人格・容姿への言及を禁止する注意書き**を
 * 常時表示すること（spec L814。開示請求で本人の目に触れ得る前提で書かせる）。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession, getTherapistDevSession } from '@/lib/cms/dev-session';
import { addHandoverNoteCore, getHandoverNotesCore } from './queries';
import type { HandoverNote } from './queries';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const addSchema = z.object({
  reservationId: z.string().uuid(),
  body: z
    .string()
    .trim()
    .min(1, '引き継ぎメモを入力してください')
    .max(500, '引き継ぎメモは500文字以内です'),
});

/**
 * 施術完了時にセラピストが一言残す（圧の好み・会話の話題・注意点）。
 * 自分の担当かつ in_service/done の予約のみ（RLS + コアの二重チェック）。
 */
export async function addHandoverNote(
  input: { reservationId: string; body: string },
  asSlug?: string,
): Promise<ActionResult<{ noteId: string }>> {
  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? '入力が不正です',
    };
  }

  try {
    const outcome = await addHandoverNoteCore(getClient(), session, parsed.data);
    switch (outcome.kind) {
      case 'ok':
        return { ok: true, data: { noteId: outcome.noteId } };
      case 'reservation_not_found':
        return { ok: false, error: '対象の予約が見つかりません' };
      case 'not_completed':
        return { ok: false, error: '施術中または完了した予約にのみ残せます' };
      case 'forbidden':
        return { ok: false, error: 'この操作はセラピスト本人のみ可能です' };
    }
  } catch (e) {
    // RLS の with check 違反（42501）等の生エラーは画面に出さない
    console.error('addHandoverNote failed:', e);
    return { ok: false, error: '引き継ぎメモの保存に失敗しました' };
  }
}

/**
 * 次回予約の顧客の過去メモ（therapist 本人）。
 * RLS により「その顧客の次回以降の自分の担当予約がある」ときだけ行が返り、
 * 無関係なセラピストには常に空になる（受入 L1123 の担保は DB 側）。
 */
export async function getHandoverNotesForNextVisit(
  customerId: string,
  asSlug?: string,
): Promise<ActionResult<HandoverNote[]>> {
  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = z.string().uuid().safeParse(customerId);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const notes = await getHandoverNotesCore(getClient(), session, {
      customerId: parsed.data,
    });
    return { ok: true, data: notes };
  } catch (e) {
    console.error('getHandoverNotesForNextVisit failed:', e);
    return { ok: false, error: '引き継ぎメモの取得に失敗しました' };
  }
}

/** 顧客のメモ一覧（staff / 電話受付の確認用） */
export async function listHandoverNotes(
  customerId: string,
): Promise<ActionResult<HandoverNote[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = z.string().uuid().safeParse(customerId);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const notes = await getHandoverNotesCore(getClient(), session, {
      customerId: parsed.data,
    });
    return { ok: true, data: notes };
  } catch (e) {
    console.error('listHandoverNotes failed:', e);
    return { ok: false, error: '引き継ぎメモの取得に失敗しました' };
  }
}
