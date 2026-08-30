'use server';

/**
 * 直前割の Server Action（フェーズ20 ★金銭 / spec L650-654）。
 * ロジックの正体は queries.ts の applyFlashDealCore（統合テストが直接叩く）。
 * ここは認証・入力検証（Zod）・CMS 設定のロード・文言変換のみを担う。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { loadFlashDealConfig } from './config';
import { applyFlashDealCore } from './queries';
import type { FlashIneligibleReason } from '@/domain/flashdeal';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const INELIGIBLE_MESSAGES: Record<FlashIneligibleReason, string> = {
  disabled: '直前割は現在無効です（CMS の flash_deal_config で有効化してください）',
  not_same_day: '当日の予約枠ではないため適用できません',
  before_trigger: '発火時刻前のため適用できません',
  outside_window: '対象時間帯外のため適用できません',
  course_not_covered: '対象コースではないため適用できません',
  daily_limit_reached: '本日の適用上限に達しています',
};

export interface ApplyFlashDealData {
  /** 割引額（円・正） */
  discount: number;
  ratePercent: number;
}

/**
 * 予約に直前割を適用する（受付・管理側）。
 * 割引は revenue_lines の discount 負行として計上され、バック計算の基礎は
 * payout_policy.discount_base（既定 '割引前'）に従う（受入 L1120・L1121）。
 */
export async function applyFlashDeal(
  reservationId: string,
): Promise<ActionResult<ApplyFlashDealData>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = z.string().uuid().safeParse(reservationId);
  if (!parsed.success) return { ok: false, error: '無効な予約IDです' };

  const sql = getClient();
  try {
    const config = await loadFlashDealConfig(sql);
    const outcome = await applyFlashDealCore(sql, session, {
      reservationId: parsed.data,
      config,
    });
    switch (outcome.kind) {
      case 'applied':
        return {
          ok: true,
          data: { discount: outcome.discount, ratePercent: outcome.ratePercent },
        };
      case 'not_found':
        return { ok: false, error: '予約が見つかりません' };
      case 'already_applied':
        return { ok: false, error: 'この予約には直前割が適用済みです' };
      case 'bad_status':
        return { ok: false, error: '確定済みの予約にのみ適用できます' };
      case 'already_started':
        return { ok: false, error: '開始済みの予約には適用できません' };
      case 'zero_discount':
        return { ok: false, error: '割引額が 0 円になるため適用しません' };
      case 'not_eligible':
        return { ok: false, error: INELIGIBLE_MESSAGES[outcome.reason] };
    }
  } catch (e) {
    // 生 Postgres エラー（制約名等）を画面に出さない
    console.error('applyFlashDeal failed:', e);
    return { ok: false, error: '直前割の適用に失敗しました' };
  }
}
