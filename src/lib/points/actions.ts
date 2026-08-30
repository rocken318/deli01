'use server';

/**
 * フェーズ16 ポイント台帳 Server Actions（spec 9章 ★ L821-849）。
 *
 * 実体は queries.ts（Session 注入型のコア）。ここは
 *   getDevSession → Zod 検証 → コア呼び出し → ActionResult 変換
 * の薄いラッパ（dispatch-board/actions.ts と同じ構成）。
 *
 * - 電話注文でも Web でも顧客（customer_id / 電話番号）に紐づけて貯まり・使える
 *   （完了条件 L1105。phone でも customerId でも引ける）
 * - 会計連動（マイナス revenue_line・引当・バック基礎算入）はフェーズ17。
 *   ここでは台帳の増減まで
 * - 生の Postgres エラー（RLS 拒否・追記専用違反等）は画面に出さず汎用文言に変換
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { earnedPoints } from '@/domain/points';
import type { LotConsumption } from '@/domain/points';
import { loadPointPolicy } from './policy';
import {
  earnPointsCore,
  expirePointsCore,
  getPointBalanceCore,
  listExpiringPointsCore,
  spendPointsCore,
} from './queries';
import type { ExpireResult, ExpiringLotItem } from './queries';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const phoneSchema = z.string().regex(/^0[0-9]{9,10}$/, '電話番号の形式が不正です');

const customerRefSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    phone: phoneSchema.optional(),
  })
  .refine((v) => v.customerId != null || v.phone != null, {
    message: '顧客IDか電話番号のどちらかが必要です',
  });

const earnSchema = customerRefSchema.and(
  z.object({
    points: z.number().int().positive(),
    reason: z.string().max(200).optional(),
    reservationId: z.string().uuid().optional(),
    /** ISO 8601。未指定は CMS の expiry_days から算出 */
    expiresAtISO: z.string().datetime({ offset: true }).optional(),
  }),
);

const useSchema = customerRefSchema.and(
  z.object({
    requestedPoints: z.number().int().positive(),
    reservationId: z.string().uuid().optional(),
    reason: z.string().max(200).optional(),
  }),
);

export interface EarnPointsData {
  entryId: string;
  customerId: string;
  balance: number;
}

/**
 * 手動付与（staff）。expiresAtISO 未指定なら CMS の expiry_days（雛形365日）で
 * 期限を付ける。ボーナス付与も reason を分けてこの関数で追記する。
 */
export async function earnPoints(
  input: z.infer<typeof earnSchema>,
): Promise<ActionResult<EarnPointsData>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = earnSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const sql = getClient();
    const policy = await loadPointPolicy(sql);
    const expiresAt = parsed.data.expiresAtISO
      ? new Date(parsed.data.expiresAtISO)
      : policy.expiryDays !== null
        ? new Date(Date.now() + policy.expiryDays * 24 * 60 * 60 * 1000)
        : null;

    const outcome = await earnPointsCore(sql, session, {
      customerId: parsed.data.customerId,
      phone: parsed.data.phone,
      points: parsed.data.points,
      reason: parsed.data.reason,
      reservationId: parsed.data.reservationId,
      expiresAt,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: {
            entryId: outcome.entryId,
            customerId: outcome.customerId,
            balance: outcome.balance,
          },
        };
      case 'customer_not_found':
        return { ok: false, error: '顧客が見つかりません' };
      case 'invalid':
        return { ok: false, error: '入力が不正です' };
    }
  } catch (e) {
    console.error('earnPoints failed:', e);
    return { ok: false, error: 'ポイント付与に失敗しました' };
  }
}

/**
 * 施術完了した予約への自動付与（支払額 × CMS 率の切り捨て / spec L838）。
 * - status='done' の予約のみ。同一予約への二重付与は拒否
 * - 電話注文・Web どちらの予約でも customer_id に紐づけて付く（完了条件 L1105）
 */
export async function earnPointsForReservation(
  reservationId: string,
): Promise<ActionResult<EarnPointsData & { points: number }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = z.string().uuid().safeParse(reservationId);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const sql = getClient();
    // 予約の確認は特権クライアント（staff アクションのため）。付与自体は
    // earnPointsCore が withUser 経由で RLS を通す。
    const rows = await sql<
      { customer_id: string | null; total_amount: number; status: string }[]
    >`
      select customer_id, total_amount, status
      from reservations where id = ${parsed.data}::uuid limit 1
    `;
    const r = rows[0];
    if (!r || r.customer_id === null) {
      return { ok: false, error: '予約が見つかりません' };
    }
    if (r.status !== 'done') {
      return { ok: false, error: '施術完了（done）の予約にのみ付与できます' };
    }
    const dup = await sql<{ id: string }[]>`
      select id::text as id from point_entries
      where reservation_id = ${parsed.data}::uuid and type = 'earn' limit 1
    `;
    if (dup.length > 0) {
      return { ok: false, error: 'この予約にはすでにポイントが付与されています' };
    }

    const policy = await loadPointPolicy(sql);
    const points = earnedPoints({
      amount: r.total_amount,
      ratePercent: policy.earnRatePercent,
    });
    if (points <= 0) {
      return { ok: false, error: '付与対象のポイントがありません（0P）' };
    }
    const expiresAt =
      policy.expiryDays !== null
        ? new Date(Date.now() + policy.expiryDays * 24 * 60 * 60 * 1000)
        : null;

    const outcome = await earnPointsCore(sql, session, {
      customerId: r.customer_id,
      points,
      reason: 'reservation_done',
      reservationId: parsed.data,
      expiresAt,
    });
    if (outcome.kind !== 'ok') {
      return { ok: false, error: 'ポイント付与に失敗しました' };
    }
    return {
      ok: true,
      data: {
        entryId: outcome.entryId,
        customerId: outcome.customerId,
        balance: outcome.balance,
        points,
      },
    };
  } catch (e) {
    // 部分 unique（point_entries_reservation_earn_uniq）違反 = 並行での二重付与を
    // DB が弾いた（reviewer B2）。事前 dup チェックをすり抜けた競合の最終防衛線。
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code?: string }).code === '23505'
    ) {
      return { ok: false, error: 'この予約にはすでにポイントが付与されています' };
    }
    console.error('earnPointsForReservation failed:', e);
    return { ok: false, error: 'ポイント付与に失敗しました' };
  }
}

export interface UsePointsData {
  used: number;
  consumption: LotConsumption[];
  balance: number;
}

/**
 * ポイント利用（staff / 電話注文・対面いずれも）。FIFO で古い付与から消費し、
 * ロットごとの use 行（負）を台帳に追記する。上限・下限は CMS point_policy。
 * 会計（discount のマイナス revenue_line）はフェーズ17 でこの結果を参照する。
 */
export async function usePoints(
  input: z.infer<typeof useSchema>,
): Promise<ActionResult<UsePointsData>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = useSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const sql = getClient();
    const policy = await loadPointPolicy(sql);
    const outcome = await spendPointsCore(sql, session, {
      customerId: parsed.data.customerId,
      phone: parsed.data.phone,
      requestedPoints: parsed.data.requestedPoints,
      reservationId: parsed.data.reservationId,
      reason: parsed.data.reason,
      minUse: policy.minUse,
      maxUse: policy.maxUse,
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          ok: true,
          data: {
            used: outcome.used,
            consumption: outcome.consumption,
            balance: outcome.balance,
          },
        };
      case 'customer_not_found':
        return { ok: false, error: '顧客が見つかりません' };
      case 'below_min':
        return { ok: false, error: `利用は${outcome.min}P以上から可能です` };
      case 'above_max':
        return { ok: false, error: `1回の利用上限は${outcome.max}Pです` };
      case 'insufficient':
        return {
          ok: false,
          error: `ポイント残高が不足しています（利用可能: ${outcome.available}P）`,
        };
      case 'invalid':
        return { ok: false, error: '入力が不正です' };
    }
  } catch (e) {
    console.error('usePoints failed:', e);
    return { ok: false, error: 'ポイント利用に失敗しました' };
  }
}

export interface PointBalanceData {
  customerId: string;
  balance: number;
}

/** 残高照会。customerId でも電話番号でも引ける（完了条件 L1105） */
export async function getPointBalance(
  input: z.infer<typeof customerRefSchema>,
): Promise<ActionResult<PointBalanceData>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = customerRefSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const outcome = await getPointBalanceCore(getClient(), session, parsed.data);
    if (outcome.kind === 'customer_not_found') {
      return { ok: false, error: '顧客が見つかりません' };
    }
    return {
      ok: true,
      data: { customerId: outcome.customerId, balance: outcome.balance },
    };
  } catch (e) {
    console.error('getPointBalance failed:', e);
    return { ok: false, error: '残高の取得に失敗しました' };
  }
}

/** 失効30日前（既定）の対象一覧（spec L841。連絡用 / staff） */
export async function listExpiringPoints(
  withinDays = 30,
): Promise<ActionResult<ExpiringLotItem[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = z.number().int().min(0).max(365).safeParse(withinDays);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const items = await listExpiringPointsCore(getClient(), session, {
      withinDays: parsed.data,
    });
    return { ok: true, data: items };
  } catch (e) {
    console.error('listExpiringPoints failed:', e);
    return { ok: false, error: '失効予定の取得に失敗しました' };
  }
}

/**
 * 期限切れロットの未消費分を expire 行（負）で相殺する日次バッチ関数。
 * cron 配線はフェーズ20（ここでは手動実行できる関数として用意）。
 * 失効ポイントの引当戻入（会計）はフェーズ17。
 */
export async function expirePoints(): Promise<ActionResult<ExpireResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  try {
    const result = await expirePointsCore(getClient(), session);
    return { ok: true, data: result };
  } catch (e) {
    console.error('expirePoints failed:', e);
    return { ok: false, error: '失効処理に失敗しました' };
  }
}

export interface PointLedgerEntry {
  id: string;
  type: string;
  points: number;
  reason: string | null;
  reservationId: string | null;
  lotId: string | null;
  expiresAt: string | null;
  occurredAt: string;
}

/**
 * 顧客の台帳履歴（直近100件）。残高照会画面のサブ表示用。
 * customerId または phone のいずれかを渡す。
 */
export async function listPointLedger(
  input: z.infer<typeof customerRefSchema>,
): Promise<ActionResult<{ entries: PointLedgerEntry[]; balance: number; customerId: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = customerRefSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const sql = getClient();
    // まず顧客IDを解決する
    const balResult = await getPointBalanceCore(sql, session, parsed.data);
    if (balResult.kind === 'customer_not_found') {
      return { ok: false, error: '顧客が見つかりません' };
    }
    const customerId = balResult.customerId;

    const rows = await sql<
      {
        id: string;
        type: string;
        points: number;
        reason: string | null;
        reservation_id: string | null;
        lot_id: string | null;
        expires_at: Date | null;
        occurred_at: Date;
      }[]
    >`
      select
        id::text as id,
        type::text as type,
        points,
        reason,
        reservation_id::text as reservation_id,
        lot_id::text as lot_id,
        expires_at,
        occurred_at
      from point_entries
      where customer_id = ${customerId}::uuid
      order by occurred_at desc, id desc
      limit 100
    `;
    return {
      ok: true,
      data: {
        customerId,
        balance: balResult.balance,
        entries: rows.map((r) => ({
          id: r.id,
          type: r.type,
          points: r.points,
          reason: r.reason,
          reservationId: r.reservation_id,
          lotId: r.lot_id,
          expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
          occurredAt: r.occurred_at.toISOString(),
        })),
      },
    };
  } catch (e) {
    console.error('listPointLedger failed:', e);
    return { ok: false, error: '台帳の取得に失敗しました' };
  }
}
