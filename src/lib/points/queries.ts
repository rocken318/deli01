import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import {
  balance as ledgerBalance,
  clampUse,
  consumeFifo,
  expiredLots,
  type LotConsumption,
  type PointLot,
} from "@/domain/points";

/**
 * ポイント台帳操作の中核（フェーズ16 / spec 9章 ★ L821-849）。
 * Server Action（actions.ts / 'use server'）から Session を受け取って動く。
 * 統合テストは getDevSession を経由せず、ここへ直接 Session を渡して検証する
 * （dispatch-board/queries.ts と同じ構成）。
 *
 * 台帳の規約（migrations/0014 の設計ノートと対）:
 * - 残高 = sum(points)。cached_points はトリガ同期のキャッシュで、正は台帳
 * - ロット = points > 0 かつ lot_id is null の行。ロット残 =
 *   points + sum(そのロットを lot_id で指す行の points)
 * - use/expire は**ロットごとに1行**（負・lot_id 必須）。FIFO の内訳が台帳に残る
 * - 同一顧客の同時利用は customers 行の `for update` ロックで直列化する
 *   （point_entries は update 権限なしのため行ロック不可。台帳は追記のみ）
 *
 * **会計連動（マイナスの revenue_line・引当・バック基礎）はフェーズ17**。
 * ここでは台帳の増減までしか行わない（spec L843-849 は 17/18 で実装）。
 */

// ---------------------------------------------------------------------------
// 共通: 顧客解決（id または電話番号 / spec L842「電話番号で識別する」）
// ---------------------------------------------------------------------------

export interface CustomerRef {
  customerId?: string;
  phone?: string;
}

async function resolveCustomerForUpdate(
  tx: TransactionSql,
  ref: CustomerRef,
  lock: boolean,
): Promise<{ id: string } | undefined> {
  if (!ref.customerId && !ref.phone) return undefined;
  const rows = ref.customerId
    ? lock
      ? await tx<{ id: string }[]>`
          select id from customers where id = ${ref.customerId}::uuid for update`
      : await tx<{ id: string }[]>`
          select id from customers where id = ${ref.customerId}::uuid`
    : lock
      ? await tx<{ id: string }[]>`
          select id from customers where phone = ${ref.phone ?? ""} for update`
      : await tx<{ id: string }[]>`
          select id from customers where phone = ${ref.phone ?? ""}`;
  return rows[0];
}

interface LotRow {
  id: string;
  occurred_at: Date;
  expires_at: Date | null;
  remaining: number;
}

/** 顧客のロット一覧（残高計算列つき）。tx 内で使う */
async function selectLots(tx: TransactionSql, customerId: string): Promise<PointLot[]> {
  const rows = await tx<LotRow[]>`
    select
      e.id::text as id,
      e.occurred_at,
      e.expires_at,
      (e.points + coalesce(
        (select sum(c.points) from point_entries c where c.lot_id = e.id), 0
      ))::integer as remaining
    from point_entries e
    where e.customer_id = ${customerId}::uuid
      and e.points > 0
      and e.lot_id is null
    order by e.occurred_at, e.id
  `;
  return rows.map((r) => ({
    lotId: r.id,
    remaining: r.remaining,
    occurredAt: r.occurred_at,
    expiresAt: r.expires_at,
  }));
}

async function selectBalance(tx: TransactionSql, customerId: string): Promise<number> {
  const rows = await tx<{ points: number }[]>`
    select points from point_entries where customer_id = ${customerId}::uuid
  `;
  return ledgerBalance(rows);
}

// ---------------------------------------------------------------------------
// 1. 付与（earn）
// ---------------------------------------------------------------------------

export interface EarnParams extends CustomerRef {
  /** 正の整数（P） */
  points: number;
  reason?: string;
  reservationId?: string;
  /** 付与ロットの失効期限。null/未指定 = 無期限 */
  expiresAt?: Date | null;
}

export type EarnOutcome =
  | { kind: "ok"; entryId: string; customerId: string; balance: number }
  | { kind: "customer_not_found" }
  | { kind: "invalid" };

export async function earnPointsCore(
  sql: Sql,
  session: Session,
  params: EarnParams,
): Promise<EarnOutcome> {
  if (!Number.isSafeInteger(params.points) || params.points <= 0) {
    return { kind: "invalid" };
  }
  return withUser(sql, session, async (tx) => {
    const customer = await resolveCustomerForUpdate(tx, params, true);
    if (!customer) return { kind: "customer_not_found" } as const;

    const inserted = await tx<{ id: string }[]>`
      insert into point_entries
        (customer_id, type, points, reservation_id, reason, expires_at, created_by)
      values (
        ${customer.id}::uuid,
        'earn',
        ${params.points},
        ${params.reservationId ?? null},
        ${params.reason ?? null},
        ${params.expiresAt ?? null},
        ${session.userId}::uuid
      )
      returning id::text as id
    `;
    const entry = inserted[0];
    if (!entry) return { kind: "invalid" } as const;
    return {
      kind: "ok",
      entryId: entry.id,
      customerId: customer.id,
      balance: await selectBalance(tx, customer.id),
    } as const;
  });
}

// ---------------------------------------------------------------------------
// 2. 利用（use）: FIFO 消費（spec L837）
// ---------------------------------------------------------------------------

export interface UsePointsParams extends CustomerRef {
  /** 正の整数（P）。1P = 1円の値引き */
  requestedPoints: number;
  reservationId?: string;
  reason?: string;
  /** CMS point_policy の利用下限/上限（actions.ts が渡す） */
  minUse?: number | null;
  maxUse?: number | null;
  /** テスト用の現在時刻注入 */
  now?: Date;
}

export type UsePointsOutcome =
  | { kind: "ok"; used: number; consumption: LotConsumption[]; balance: number }
  | { kind: "customer_not_found" }
  | { kind: "invalid" }
  | { kind: "below_min"; min: number }
  | { kind: "above_max"; max: number }
  | { kind: "insufficient"; available: number }
  | { kind: "revenue_already_posted" };

export async function spendPointsCore(
  sql: Sql,
  session: Session,
  params: UsePointsParams,
): Promise<UsePointsOutcome> {
  if (!Number.isSafeInteger(params.requestedPoints) || params.requestedPoints <= 0) {
    return { kind: "invalid" };
  }
  const now = params.now ?? new Date();

  return withUser(sql, session, async (tx) => {
    // 同一顧客のポイント操作を直列化（二重消費の防止）
    const customer = await resolveCustomerForUpdate(tx, params, true);
    if (!customer) return { kind: "customer_not_found" } as const;

    // 予約の売上が既に計上済みなら、ポイント利用は point_use の値引行として
    // 反映できない（フェーズ17 は再計上不可）。台帳だけ減って売上が過大に固定
    // されるのを防ぐため拒否する（reviewer B1 / spec L847）。運用順序は
    // 「done → usePoints → postReservationRevenue」。
    if (params.reservationId) {
      const posted = await tx`
        select 1 from revenue_lines
        where reservation_id = ${params.reservationId}::uuid
          and reversal_of is null
          and line_type in ('course', 'option', 'nomination', 'transport', 'midnight')
        limit 1
      `;
      if (posted.length > 0) {
        return { kind: "revenue_already_posted" } as const;
      }
    }

    const lots = await selectLots(tx, customer.id);
    const available = lots
      .filter((l) => l.remaining > 0 && (l.expiresAt === null || l.expiresAt > now))
      .reduce((sum, l) => sum + l.remaining, 0);

    // 上限・下限・残高（期限内の消費可能合計に対して判定）
    const clamped = clampUse({
      requested: params.requestedPoints,
      min: params.minUse ?? null,
      max: params.maxUse ?? null,
      balance: available,
    });
    if (!clamped.ok) {
      switch (clamped.reason) {
        case "below_min":
          return { kind: "below_min", min: params.minUse ?? 0 } as const;
        case "above_max":
          return { kind: "above_max", max: params.maxUse ?? 0 } as const;
        case "insufficient":
          return { kind: "insufficient", available } as const;
        default:
          return { kind: "invalid" } as const;
      }
    }

    const result = consumeFifo({ lots, usePoints: clamped.use, now });
    if (!result.ok) {
      return { kind: "insufficient", available: result.available } as const;
    }

    // ロットごとに use 行（負）を追記。内訳がそのまま台帳に残る
    for (const c of result.consumption) {
      await tx`
        insert into point_entries
          (customer_id, type, points, reservation_id, reason, lot_id, occurred_at, created_by)
        values (
          ${customer.id}::uuid,
          'use',
          ${-c.amount},
          ${params.reservationId ?? null},
          ${params.reason ?? null},
          ${c.lotId}::bigint,
          ${now},
          ${session.userId}::uuid
        )
      `;
    }

    return {
      kind: "ok",
      used: result.total,
      consumption: result.consumption,
      balance: await selectBalance(tx, customer.id),
    } as const;
  });
}

// ---------------------------------------------------------------------------
// 3. 残高（id でも電話番号でも / 完了条件 L1105「電話注文でも貯まり、使える」）
// ---------------------------------------------------------------------------

export type BalanceOutcome =
  | { kind: "ok"; customerId: string; balance: number }
  | { kind: "customer_not_found" };

export async function getPointBalanceCore(
  sql: Sql,
  session: Session,
  ref: CustomerRef,
): Promise<BalanceOutcome> {
  return withUser(sql, session, async (tx) => {
    const customer = await resolveCustomerForUpdate(tx, ref, false);
    if (!customer) return { kind: "customer_not_found" } as const;
    return {
      kind: "ok",
      customerId: customer.id,
      balance: await selectBalance(tx, customer.id),
    } as const;
  });
}

// ---------------------------------------------------------------------------
// 4. 失効予定一覧（spec L841「失効30日前の対象一覧」）
// ---------------------------------------------------------------------------

export interface ExpiringLotItem {
  customerId: string;
  phone: string;
  name: string;
  lotId: string;
  remaining: number;
  expiresAt: Date;
}

export async function listExpiringPointsCore(
  sql: Sql,
  session: Session,
  params: { withinDays: number; now?: Date },
): Promise<ExpiringLotItem[]> {
  const now = params.now ?? new Date();
  const limit = new Date(now.getTime() + params.withinDays * 24 * 60 * 60 * 1000);
  return withUser(sql, session, async (tx) => {
    const rows = await tx<
      {
        customer_id: string;
        phone: string;
        name: string;
        lot_id: string;
        remaining: number;
        expires_at: Date;
      }[]
    >`
      select
        e.customer_id,
        cu.phone,
        cu.name,
        e.id::text as lot_id,
        (e.points + coalesce(
          (select sum(c.points) from point_entries c where c.lot_id = e.id), 0
        ))::integer as remaining,
        e.expires_at
      from point_entries e
      join customers cu on cu.id = e.customer_id
      where e.points > 0
        and e.lot_id is null
        and e.expires_at is not null
        and e.expires_at > ${now}
        and e.expires_at <= ${limit}
        and (e.points + coalesce(
          (select sum(c.points) from point_entries c where c.lot_id = e.id), 0
        )) > 0
      order by e.expires_at, e.id
    `;
    return rows.map((r) => ({
      customerId: r.customer_id,
      phone: r.phone,
      name: r.name,
      lotId: r.lot_id,
      remaining: r.remaining,
      expiresAt: r.expires_at,
    }));
  });
}

// ---------------------------------------------------------------------------
// 5. 失効バッチ（日次 / spec L841。cron 配線はフェーズ20 — 関数のみ用意）
// ---------------------------------------------------------------------------

export interface ExpireResult {
  /** 失効処理したロット数 */
  expiredLotCount: number;
  /** 落としたポイント合計（正の数） */
  expiredPoints: number;
}

export async function expirePointsCore(
  sql: Sql,
  session: Session,
  params?: { now?: Date },
): Promise<ExpireResult> {
  const now = params?.now ?? new Date();
  return withUser(sql, session, async (tx) => {
    // 1. 期限切れ × 残あり のロット候補（顧客横断）
    const candidates = await tx<
      { customer_id: string; id: string; occurred_at: Date; expires_at: Date; remaining: number }[]
    >`
      select
        e.customer_id,
        e.id::text as id,
        e.occurred_at,
        e.expires_at,
        (e.points + coalesce(
          (select sum(c.points) from point_entries c where c.lot_id = e.id), 0
        ))::integer as remaining
      from point_entries e
      where e.points > 0
        and e.lot_id is null
        and e.expires_at is not null
        and e.expires_at <= ${now}
    `;
    const customerIds = [...new Set(candidates.map((c) => c.customer_id))];
    if (customerIds.length === 0) {
      return { expiredLotCount: 0, expiredPoints: 0 };
    }

    // 2. 対象顧客をロックして並行 use と直列化 → ロック後にロット残を再計算
    await tx`
      select id from customers
      where id = any(${customerIds}::uuid[])
      order by id
      for update
    `;

    let expiredLotCount = 0;
    let expiredPoints = 0;
    for (const customerId of customerIds) {
      const lots = await selectLots(tx, customerId);
      const targets = expiredLots({ lots, now });
      for (const t of targets) {
        await tx`
          insert into point_entries
            (customer_id, type, points, reason, lot_id, occurred_at, created_by)
          values (
            ${customerId}::uuid,
            'expire',
            ${-t.amount},
            'expired',
            ${t.lotId}::bigint,
            ${now},
            ${session.userId}::uuid
          )
        `;
        expiredLotCount += 1;
        expiredPoints += t.amount;
      }
    }
    return { expiredLotCount, expiredPoints };
  });
}
