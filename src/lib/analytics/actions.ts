'use server';

/**
 * フェーズ19 集計 Server Actions（spec 19章）。
 *
 * getDevSession → Zod 検証 → コア呼び出し → ActionResult 変換
 * の薄いラッパ（accounting/actions.ts と同じ構成）。
 * 生の Postgres エラー（RLS 拒否等）は画面に出さず汎用文言に変換する。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import type { ActionResult } from '@/lib/accounting/actions';
import { getReconciliationCore, getDemandHeatmapCore, getTherapistBreakdownCore } from './queries';
import type {
  ReconciliationResult,
  HeatmapResult,
  AreaReconciliation,
  DemandHeatmapCell,
  TherapistBreakdownRow,
  TherapistBreakdownResult,
} from './queries';

const periodSchema = z.object({
  fromISO: z.string().datetime({ offset: true }),
  toISO: z.string().datetime({ offset: true }),
  areaId: z.string().uuid().nullish(),
});

// ---------------------------------------------------------------------------
// 1. エリア別突合集計
// ---------------------------------------------------------------------------

/**
 * エリア別突合（売上/バック/経費/粗利/客単価）を集計して返す。
 * 期間は [fromISO, toISO) の半開区間（ISO 8601）。
 */
export async function getReconciliation(
  input: z.infer<typeof periodSchema>,
): Promise<ActionResult<ReconciliationResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = periodSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  const from = new Date(parsed.data.fromISO);
  const to = new Date(parsed.data.toISO);
  if (!(from.getTime() < to.getTime())) {
    return { ok: false, error: '期間の指定が不正です' };
  }

  try {
    const result = await getReconciliationCore(getClient(), session, {
      from,
      to,
      areaId: parsed.data.areaId ?? null,
    });
    return { ok: true, data: result };
  } catch (e) {
    console.error('getReconciliation failed:', e);
    return { ok: false, error: '突合集計の取得に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 2. 需要ヒートマップ集計
// ---------------------------------------------------------------------------

/**
 * 需要ヒートマップ（曜日 × エリア × lost/won）を集計して返す。
 * 期間は [fromISO, toISO) の半開区間（ISO 8601）。
 */
export async function getDemandHeatmap(
  input: z.infer<typeof periodSchema>,
): Promise<ActionResult<HeatmapResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = periodSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  const from = new Date(parsed.data.fromISO);
  const to = new Date(parsed.data.toISO);
  if (!(from.getTime() < to.getTime())) {
    return { ok: false, error: '期間の指定が不正です' };
  }

  try {
    const result = await getDemandHeatmapCore(getClient(), session, {
      from,
      to,
      areaId: parsed.data.areaId ?? null,
    });
    return { ok: true, data: result };
  } catch (e) {
    console.error('getDemandHeatmap failed:', e);
    return { ok: false, error: 'ヒートマップ集計の取得に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 3. セラピスト別集計
// ---------------------------------------------------------------------------

const therapistBreakdownSchema = z.object({
  fromISO: z.string().datetime({ offset: true }),
  toISO: z.string().datetime({ offset: true }),
});

/**
 * セラピスト別売上集計（完了件数・指名件数・売上合計）を返す。
 * 期間は [fromISO, toISO) の半開区間（ISO 8601）。
 */
export async function getTherapistBreakdown(
  input: z.infer<typeof therapistBreakdownSchema>,
): Promise<ActionResult<TherapistBreakdownResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = therapistBreakdownSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  const from = new Date(parsed.data.fromISO);
  const to = new Date(parsed.data.toISO);
  if (!(from.getTime() < to.getTime())) {
    return { ok: false, error: '期間の指定が不正です' };
  }

  try {
    const result = await getTherapistBreakdownCore(getClient(), session, { from, to });
    return { ok: true, data: result };
  } catch (e) {
    console.error('getTherapistBreakdown failed:', e);
    return { ok: false, error: 'セラピスト別集計の取得に失敗しました' };
  }
}

export type {
  ReconciliationResult,
  HeatmapResult,
  AreaReconciliation,
  DemandHeatmapCell,
  TherapistBreakdownRow,
  TherapistBreakdownResult,
};
