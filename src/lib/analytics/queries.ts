import "server-only";
import type { Sql } from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { settlement, pointLiability, deferredRevenue } from "@/domain/accounting";

/**
 * フェーズ19 集計・突合・ヒートマップのコアクエリ（spec 19章）。
 *
 * Server Action（actions.ts / 'use server'）から Session を受け取って動く
 * （accounting/queries.ts と同じ構成）。
 * - revenue_lines / payout_lines / expenses / lost_orders / reservations を
 *   エリア別に独立集計し、settlement() 純関数で突合する
 * - ヒートマップは lost_orders × reservations を曜日 × エリアでクロス集計
 * - 金額はすべて整数（円）。小数は使わない
 */

// ---------------------------------------------------------------------------
// 公開型
// ---------------------------------------------------------------------------

export interface AreaReconciliation {
  /** null = エリア不明（revenue_lines.area_id が null の行）*/
  areaId: string | null;
  areaName: string | null;
  /** revenue_lines の期間合計（逆仕訳込み） */
  revenue: number;
  /** payout_lines の期間合計（reversal_of is null のみ） */
  payout: number;
  /** expenses の期間合計 */
  expenses: number;
  /** revenue - payout - expenses */
  grossProfit: number;
  /** revenue_lines のユニーク reservation_id 数 */
  reservationCount: number;
  /** 客単価 = floor(revenue / reservationCount)。0件なら0 */
  avgRevenue: number;
}

export interface ReconciliationResult {
  byArea: AreaReconciliation[];
  /** 全エリア合計 */
  total: AreaReconciliation;
  /** 支払方法別合計 (cash/card/emoney/ticket/point) */
  paymentsByMethod: Record<string, number>;
  /** 期末引当残（point_entries sum を to 時点で集計） */
  pointLiability: number;
  /** 期末前受金残高（ticket_entries sum を to 時点で集計） */
  deferredRevenue: number;
}

export interface DemandHeatmapCell {
  /** 0=日曜〜6=土曜 */
  dow: number;
  areaId: string | null;
  areaName: string | null;
  lostCount: number;
  /** reservations (done/confirmed/in_service/enroute/held) */
  wonCount: number;
}

export interface HeatmapResult {
  cells: DemandHeatmapCell[];
  /** { time: N, area: N, nomination: N, price: N, other: N } */
  reasons: Record<string, number>;
}

// ---------------------------------------------------------------------------
// 内部型（クエリ結果の行）
// ---------------------------------------------------------------------------

interface RevRow {
  area_id: string | null;
  revenue: number;
  res_count: number;
}

interface PayRow {
  area_id: string | null;
  payout: number;
}

interface ExpRow {
  area_id: string | null;
  expenses: number;
}

interface AreaRow {
  id: string;
  name: string;
}

interface PaymentMethodRow {
  method: string;
  total: number;
}

interface LostDowRow {
  dow: number;
  area_id: string | null;
  lost_count: number;
}

interface WonDowRow {
  dow: number;
  area_id: string | null;
  won_count: number;
}

interface ReasonRow {
  reason: string;
  cnt: number;
}

// ---------------------------------------------------------------------------
// getReconciliationCore
// ---------------------------------------------------------------------------

/**
 * エリア別突合集計（spec 19章 突合機能）。
 *
 * @param params.from  期間開始（inclusive、timestamptz として比較）
 * @param params.to    期間終了（exclusive、timestamptz として比較）
 * @param params.areaId  指定時はそのエリアのみ（null = 全エリア）
 */
export async function getReconciliationCore(
  sql: Sql,
  session: Session,
  params: { from: Date; to: Date; areaId?: string | null },
): Promise<ReconciliationResult> {
  return withUser(sql, session, async (tx) => {
    // 1. revenue_lines — area_id 別（逆仕訳込みで sum。spec L858）
    const revRows = await tx<RevRow[]>`
      select
        rl.area_id,
        sum(rl.amount)::integer as revenue,
        count(distinct rl.reservation_id)::integer as res_count
      from revenue_lines rl
      where rl.occurred_at >= ${params.from}
        and rl.occurred_at < ${params.to}
        ${params.areaId != null ? tx`and rl.area_id = ${params.areaId}::uuid` : tx``}
      group by rl.area_id
    `;

    // 2. payout_lines — reservation.area_id 別（reversal_of is null のみ）
    //    adjustment 行（reservation_id is null）は area_id = null バケツへ
    const payRows = await tx<PayRow[]>`
      select r.area_id, sum(pl.amount)::integer as payout
      from payout_lines pl
      join reservations r on r.id = pl.reservation_id
      where pl.business_date >= (${params.from}::timestamptz at time zone 'Asia/Tokyo')::date
        and pl.business_date < (${params.to}::timestamptz at time zone 'Asia/Tokyo')::date
        and pl.reversal_of is null
        ${params.areaId != null ? tx`and r.area_id = ${params.areaId}::uuid` : tx``}
      group by r.area_id
    `;

    // 3. adjustment rows (payout_lines with no reservation_id) → null area bucket
    const adjRows = await tx<{ payout: number }[]>`
      select sum(pl.amount)::integer as payout
      from payout_lines pl
      where pl.reservation_id is null
        and pl.business_date >= (${params.from}::timestamptz at time zone 'Asia/Tokyo')::date
        and pl.business_date < (${params.to}::timestamptz at time zone 'Asia/Tokyo')::date
        and pl.reversal_of is null
    `;
    const adjPayout = adjRows[0]?.payout ?? 0;

    // 4. expenses — area_id 別（spent_on は Asia/Tokyo 日付として比較）
    const expRows = await tx<ExpRow[]>`
      select area_id, sum(amount)::integer as expenses
      from expenses
      where spent_on >= (${params.from}::timestamptz at time zone 'Asia/Tokyo')::date
        and spent_on < (${params.to}::timestamptz at time zone 'Asia/Tokyo')::date
        ${params.areaId != null ? tx`and area_id = ${params.areaId}::uuid` : tx``}
      group by area_id
    `;

    // 5. 支払方法別合計（reservations 経由でエリア絞り込み）
    const methodRows = await tx<PaymentMethodRow[]>`
      select p.method::text as method, sum(p.amount)::integer as total
      from payments p
      join reservations r on r.id = p.reservation_id
      where p.occurred_at >= ${params.from}
        and p.occurred_at < ${params.to}
        ${params.areaId != null ? tx`and r.area_id = ${params.areaId}::uuid` : tx``}
      group by p.method
    `;

    // 6. エリア名解決
    const areaRows = await tx<AreaRow[]>`select id, name from areas order by name`;
    const areaNameMap = new Map<string, string>(
      areaRows.map((a) => [a.id, a.name]),
    );

    // 7. ポイント引当（期末時点 = to 未満の全社残 / accounting/queries.ts L817-834）
    const liaRows = await tx<
      { earned: number; used: number; expired: number; adjusted: number }[]
    >`
      select
        coalesce(sum(points) filter (where type = 'earn'), 0)::integer as earned,
        coalesce(-sum(points) filter (where type = 'use'), 0)::integer as used,
        coalesce(-sum(points) filter (where type = 'expire'), 0)::integer as expired,
        coalesce(sum(points) filter (where type in ('adjust', 'reverse')), 0)::integer as adjusted
      from point_entries
      where occurred_at < ${params.to}
    `;
    const lia = liaRows[0] ?? { earned: 0, used: 0, expired: 0, adjusted: 0 };
    const liabilityBreakdown = pointLiability([
      { type: "earn", points: lia.earned },
      { type: "use", points: -lia.used },
      { type: "expire", points: -lia.expired },
      { type: "adjust", points: lia.adjusted },
    ]);

    // 8. 前受金 = 回数券残（期末時点 / accounting/queries.ts L837-846）
    const ticketRows = await tx<{ count: number; amount: number }[]>`
      select
        coalesce(sum(count), 0)::integer as count,
        coalesce(sum(amount), 0)::integer as amount
      from ticket_entries
      where occurred_at < ${params.to}
    `;
    const deferred = deferredRevenue(ticketRows[0] ? [ticketRows[0]] : []);

    // ---------------------------------------------------------------------------
    // 組み立て
    // ---------------------------------------------------------------------------

    // 全エリアキーの収集（revenue / payout / expenses に現れたもの全部）
    const areaIdSet = new Set<string | null>();
    for (const r of revRows) areaIdSet.add(r.area_id);
    for (const r of payRows) areaIdSet.add(r.area_id);
    for (const r of expRows) areaIdSet.add(r.area_id);
    // null バケツは adjPayout > 0 なら必ず含める
    if (adjPayout !== 0) areaIdSet.add(null);

    // マップに変換
    const revMap = new Map<string | null, { revenue: number; resCount: number }>();
    for (const r of revRows) revMap.set(r.area_id, { revenue: r.revenue, resCount: r.res_count });

    const payMap = new Map<string | null, number>();
    for (const r of payRows) payMap.set(r.area_id, r.payout);
    // adjustment を null バケツへ加算
    payMap.set(null, (payMap.get(null) ?? 0) + adjPayout);

    const expMap = new Map<string | null, number>();
    for (const r of expRows) expMap.set(r.area_id, r.expenses);

    const byArea: AreaReconciliation[] = [];
    for (const areaId of areaIdSet) {
      const { revenue, resCount } = revMap.get(areaId) ?? { revenue: 0, resCount: 0 };
      const payout = payMap.get(areaId) ?? 0;
      const expenses = expMap.get(areaId) ?? 0;
      const s = settlement({ revenue, payout, expenses });
      const avgRevenue = resCount > 0 ? Math.floor(revenue / resCount) : 0;
      byArea.push({
        areaId,
        areaName: areaId != null ? (areaNameMap.get(areaId) ?? null) : null,
        revenue,
        payout,
        expenses,
        grossProfit: s.grossProfit,
        reservationCount: resCount,
        avgRevenue,
      });
    }

    // 名前順ソート（null last）
    byArea.sort((a, b) => {
      if (a.areaName == null && b.areaName == null) return 0;
      if (a.areaName == null) return 1;
      if (b.areaName == null) return -1;
      return a.areaName.localeCompare(b.areaName, "ja");
    });

    // 全エリア合計
    const totalRevenue = byArea.reduce((s, a) => s + a.revenue, 0);
    const totalPayout = byArea.reduce((s, a) => s + a.payout, 0);
    const totalExpenses = byArea.reduce((s, a) => s + a.expenses, 0);
    const totalResCount = byArea.reduce((s, a) => s + a.reservationCount, 0);
    const totalSettlement = settlement({
      revenue: totalRevenue,
      payout: totalPayout,
      expenses: totalExpenses,
    });
    const total: AreaReconciliation = {
      areaId: null,
      areaName: null,
      revenue: totalRevenue,
      payout: totalPayout,
      expenses: totalExpenses,
      grossProfit: totalSettlement.grossProfit,
      reservationCount: totalResCount,
      avgRevenue: totalResCount > 0 ? Math.floor(totalRevenue / totalResCount) : 0,
    };

    // 支払方法別
    const paymentsByMethod: Record<string, number> = {
      cash: 0,
      card: 0,
      emoney: 0,
      ticket: 0,
      point: 0,
    };
    for (const row of methodRows) {
      if (row.method in paymentsByMethod) {
        paymentsByMethod[row.method] = row.total;
      }
    }

    return {
      byArea,
      total,
      paymentsByMethod,
      pointLiability: liabilityBreakdown.liability,
      deferredRevenue: deferred.deferredAmount,
    };
  });
}

// ---------------------------------------------------------------------------
// getDemandHeatmapCore
// ---------------------------------------------------------------------------

/**
 * 需要ヒートマップ（曜日 × エリア）集計（spec 19章 ヒートマップ機能）。
 *
 * lost_orders（機会損失）と reservations（成約）を曜日 × エリアでクロスし、
 * セルが lostCount > 0 or wonCount > 0 のときのみ返す。
 *
 * @param params.from  期間開始（inclusive）
 * @param params.to    期間終了（exclusive）
 * @param params.areaId  指定時はそのエリアのみ（null = 全エリア）
 */
export async function getDemandHeatmapCore(
  sql: Sql,
  session: Session,
  params: { from: Date; to: Date; areaId?: string | null },
): Promise<HeatmapResult> {
  return withUser(sql, session, async (tx) => {
    // 1. lost_orders — 曜日 × エリア
    const lostRows = await tx<LostDowRow[]>`
      select
        extract(dow from created_at at time zone 'Asia/Tokyo')::integer as dow,
        area_id,
        count(*)::integer as lost_count
      from lost_orders
      where created_at >= ${params.from}
        and created_at < ${params.to}
        ${params.areaId != null ? tx`and area_id = ${params.areaId}::uuid` : tx``}
      group by dow, area_id
    `;

    // 2. reservations — 曜日 × エリア（cancelled/noshow 除外）
    const wonRows = await tx<WonDowRow[]>`
      select
        extract(dow from start_at at time zone 'Asia/Tokyo')::integer as dow,
        area_id,
        count(*)::integer as won_count
      from reservations
      where start_at >= ${params.from}
        and start_at < ${params.to}
        and status not in ('cancelled', 'noshow')
        ${params.areaId != null ? tx`and area_id = ${params.areaId}::uuid` : tx``}
      group by dow, area_id
    `;

    // 3. lost_orders reason 集計
    const reasonRows = await tx<ReasonRow[]>`
      select reason::text as reason, count(*)::integer as cnt
      from lost_orders
      where created_at >= ${params.from}
        and created_at < ${params.to}
        ${params.areaId != null ? tx`and area_id = ${params.areaId}::uuid` : tx``}
      group by reason
    `;

    // 4. エリア名解決
    const areaRows = await tx<AreaRow[]>`select id, name from areas`;
    const areaNameMap = new Map<string, string>(
      areaRows.map((a) => [a.id, a.name]),
    );

    // ---------------------------------------------------------------------------
    // 組み立て
    // ---------------------------------------------------------------------------

    type CellKey = `${number}:${string}`;
    const cellMap = new Map<
      CellKey,
      { dow: number; areaId: string | null; lostCount: number; wonCount: number }
    >();

    const cellKey = (dow: number, areaId: string | null): CellKey =>
      `${dow}:${areaId ?? "null"}` as CellKey;

    for (const r of lostRows) {
      const key = cellKey(r.dow, r.area_id);
      const existing = cellMap.get(key);
      if (existing) {
        existing.lostCount += r.lost_count;
      } else {
        cellMap.set(key, {
          dow: r.dow,
          areaId: r.area_id,
          lostCount: r.lost_count,
          wonCount: 0,
        });
      }
    }

    for (const r of wonRows) {
      const key = cellKey(r.dow, r.area_id);
      const existing = cellMap.get(key);
      if (existing) {
        existing.wonCount += r.won_count;
      } else {
        cellMap.set(key, {
          dow: r.dow,
          areaId: r.area_id,
          lostCount: 0,
          wonCount: r.won_count,
        });
      }
    }

    const cells: DemandHeatmapCell[] = Array.from(cellMap.values()).map(
      (c) => ({
        dow: c.dow,
        areaId: c.areaId,
        areaName: c.areaId != null ? (areaNameMap.get(c.areaId) ?? null) : null,
        lostCount: c.lostCount,
        wonCount: c.wonCount,
      }),
    );

    // dow 昇順 → エリア名昇順
    cells.sort((a, b) => {
      if (a.dow !== b.dow) return a.dow - b.dow;
      if (a.areaName == null && b.areaName == null) return 0;
      if (a.areaName == null) return 1;
      if (b.areaName == null) return -1;
      return a.areaName.localeCompare(b.areaName, "ja");
    });

    const reasons: Record<string, number> = {
      time: 0,
      area: 0,
      nomination: 0,
      price: 0,
      other: 0,
    };
    for (const r of reasonRows) {
      if (r.reason in reasons) {
        reasons[r.reason] = r.cnt;
      }
    }

    return { cells, reasons };
  });
}
