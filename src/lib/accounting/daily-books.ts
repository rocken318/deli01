import "server-only";
import type { Sql } from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { settlement } from "@/domain/accounting";
import type { BusinessDayRange } from "@/domain/accounting";

/**
 * G 日次会計（受付表の確認用 / SGS 形）のコア集計。
 *
 * 既存台帳の上の読み取りレンズ（新規テーブルなし・締めロックなし / 発注者確認 2026-09-02）。
 * 営業日境界（06:00 JST）は businessDayRange が算出済みの range で受け取る。
 * - 売上 = revenue_lines（occurred_at 範囲・逆仕訳込みで sum）。ただし
 *   **交通費（transport）は店の売上に含めない**（発注者決定 2026-09-04）。交通費は
 *   お客様から集金し店がドライバーへ支払う経費＝相殺の預り金。売上・バックには入れず、
 *   transportPassthrough として別枠で見せる（粗利は交通費で増減しない＝集金と支払が相殺）
 * - バック = payout_lines（**逆仕訳込みの純額**。予約行は予約 start_at 範囲で、
 *   調整行は business_date 暦日範囲で＝売上と同じ予約集合に揃える）。
 *   逆仕訳（reversal_of つき負行）も予約経由で同じ日に寄せて相殺する（過大計上を防ぐ）
 * - 経費 = expenses（spent_on 暦日範囲）
 * - 粗利 = settlement()（売上 − バック − 経費）
 * 集計単位は個人別＋店舗合計（エリア別内訳は出さない / 発注者選択）。RLS 下（owner/admin）。
 */

export interface TherapistBooksRow {
  therapistId: string;
  therapistName: string;
  /** 売上に現れた予約数（ユニーク reservation_id） */
  reservationCount: number;
  /** 売上（円・逆仕訳込み） */
  revenue: number;
  /** バック（円・reversal_of is null） */
  payout: number;
  /** 店取分 = 売上 − バック（経費は店舗側で別集計） */
  storeShare: number;
}

export interface DailyBooksResult {
  storeTotal: {
    revenue: number;
    payout: number;
    expenses: number;
    /** 売上 − バック − 経費 */
    grossProfit: number;
    reservationCount: number;
  };
  byTherapist: TherapistBooksRow[];
  /** cash/card/emoney/ticket/point の合計 */
  paymentsByMethod: Record<string, number>;
  /**
   * 交通費のお預り（＝ドライバー代の原資）。お客様から集金し店が支払う経費で相殺される
   * 通過項目。売上・バック・粗利には含めない（発注者決定 2026-09-04）。参考表示用。
   */
  transportPassthrough: number;
}

interface RevRow {
  therapist_id: string | null;
  revenue: number;
  res_count: number;
}
interface PayRow {
  therapist_id: string;
  payout: number;
}
interface NameRow {
  id: string;
  name: string;
}
interface MethodRow {
  method: string;
  total: number;
}

export async function getDailyBooksCore(
  sql: Sql,
  session: Session,
  range: BusinessDayRange,
): Promise<DailyBooksResult> {
  return withUser(sql, session, async (tx) => {
    const { from, to, fromDate, toDate } = range;

    // 1. 店舗合計の売上（全 revenue_lines・逆仕訳込み）。★交通費は売上に含めない。
    const storeRev = await tx<{ revenue: number; res_count: number }[]>`
      select coalesce(sum(amount) filter (where line_type <> 'transport'), 0)::integer as revenue,
             count(distinct reservation_id)::integer as res_count
      from revenue_lines
      where occurred_at >= ${from} and occurred_at < ${to}
    `;

    // 1b. 交通費のお預り（通過項目・売上外）。ドライバー代の原資として別枠表示。
    const transportRow = await tx<{ transport: number }[]>`
      select coalesce(sum(amount), 0)::integer as transport
      from revenue_lines
      where occurred_at >= ${from} and occurred_at < ${to}
        and line_type = 'transport'
    `;

    // 2. セラピスト別の売上（★交通費除外）
    const revRows = await tx<RevRow[]>`
      select therapist_id,
             coalesce(sum(amount) filter (where line_type <> 'transport'), 0)::integer as revenue,
             count(distinct reservation_id)::integer as res_count
      from revenue_lines
      where occurred_at >= ${from} and occurred_at < ${to}
        and therapist_id is not null
      group by therapist_id
    `;

    // 3a. セラピスト別バック（予約行＝予約 start_at 範囲で売上に揃える）。
    //     逆仕訳（reversal_of つき負行）も同じ予約経由で拾い、純額で相殺する。
    const payResRows = await tx<PayRow[]>`
      select pl.therapist_id, coalesce(sum(pl.amount), 0)::integer as payout
      from payout_lines pl
      join reservations r on r.id = pl.reservation_id
      where r.start_at >= ${from} and r.start_at < ${to}
      group by pl.therapist_id
    `;
    // 3b. 調整行（reservation_id null）は business_date 暦日範囲で（逆仕訳・調整とも純額）
    const payAdjRows = await tx<PayRow[]>`
      select pl.therapist_id, coalesce(sum(pl.amount), 0)::integer as payout
      from payout_lines pl
      where pl.reservation_id is null
        and pl.business_date >= ${fromDate}::date and pl.business_date < ${toDate}::date
      group by pl.therapist_id
    `;

    // 4. 経費（店舗合計・spent_on 暦日範囲）
    const expRows = await tx<{ expenses: number }[]>`
      select coalesce(sum(amount), 0)::integer as expenses
      from expenses
      where spent_on >= ${fromDate}::date and spent_on < ${toDate}::date
    `;

    // 5. 支払方法別（occurred_at 範囲）
    const methodRows = await tx<MethodRow[]>`
      select method::text as method, sum(amount)::integer as total
      from payments
      where occurred_at >= ${from} and occurred_at < ${to}
      group by method
    `;

    // 6. セラピスト名解決（登場した id のみ）
    const payMap = new Map<string, number>();
    for (const r of payResRows) payMap.set(r.therapist_id, r.payout);
    for (const r of payAdjRows) payMap.set(r.therapist_id, (payMap.get(r.therapist_id) ?? 0) + r.payout);

    const revMap = new Map<string, { revenue: number; resCount: number }>();
    for (const r of revRows) {
      if (r.therapist_id) revMap.set(r.therapist_id, { revenue: r.revenue, resCount: r.res_count });
    }

    const ids = new Set<string>([...revMap.keys(), ...payMap.keys()]);
    const nameRows = ids.size
      ? await tx<NameRow[]>`
          select t.id,
                 coalesce(er.published ->> 'name', er.draft ->> 'name', t.slug) as name
          from therapists t
          left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
          where t.id = any(${sql.array([...ids])}::uuid[])
        `
      : [];
    const nameMap = new Map<string, string>(nameRows.map((n) => [n.id, n.name]));

    const byTherapist: TherapistBooksRow[] = [...ids].map((id) => {
      const rev = revMap.get(id) ?? { revenue: 0, resCount: 0 };
      const payout = payMap.get(id) ?? 0;
      return {
        therapistId: id,
        therapistName: nameMap.get(id) ?? id,
        reservationCount: rev.resCount,
        revenue: rev.revenue,
        payout,
        storeShare: rev.revenue - payout,
      };
    });
    byTherapist.sort((a, b) => b.revenue - a.revenue || b.storeShare - a.storeShare);

    const revenue = storeRev[0]?.revenue ?? 0;
    const payout = [...payMap.values()].reduce((s, v) => s + v, 0);
    const expenses = expRows[0]?.expenses ?? 0;
    const s = settlement({ revenue, payout, expenses });

    const paymentsByMethod: Record<string, number> = { cash: 0, card: 0, emoney: 0, ticket: 0, point: 0 };
    for (const m of methodRows) {
      if (m.method in paymentsByMethod) paymentsByMethod[m.method] = m.total;
    }

    return {
      storeTotal: {
        revenue,
        payout,
        expenses,
        grossProfit: s.grossProfit,
        reservationCount: storeRev[0]?.res_count ?? 0,
      },
      byTherapist,
      paymentsByMethod,
      transportPassthrough: transportRow[0]?.transport ?? 0,
    };
  });
}
