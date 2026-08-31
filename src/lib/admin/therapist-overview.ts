import "server-only";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";

const TZ = "Asia/Tokyo";
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 報酬カテゴリ（payout_lines.category）→ 管理表示ラベル */
export const PAYOUT_CATEGORY_LABELS: Record<string, string> = {
  course: "コース",
  option: "オプション",
  nomination: "指名",
  transport: "交通費",
  late_night: "深夜",
  cancel_fee: "キャンセル料",
};

export interface OverviewDay {
  dateISO: string;
  hasShift: boolean;
  isDayOff: boolean;
  startHHmm: string | null;
  endHHmm: string | null;
  reservationCount: number;
}

export interface TherapistMonthOverview {
  therapistSlug: string;
  displayName: string;
  monthISO: string;
  days: OverviewDay[];
  shiftDays: number;
  reservationTotal: number;
  earnings: {
    monthTotal: number;
    byCategory: { category: string; label: string; amount: number }[];
  };
}

export type OverviewOutcome =
  | { kind: "ok"; data: TherapistMonthOverview }
  | { kind: "forbidden" }
  | { kind: "not_found" };

function monthBounds(monthISO: string) {
  const [y, m] = monthISO.split("-").map(Number);
  const startDateISO = `${monthISO}-01`;
  const nextY = m === 12 ? y! + 1 : y!;
  const nextM = m === 12 ? 1 : m! + 1;
  const endDateISO = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  return {
    startDateISO,
    endDateISO,
    monthStart: fromZonedTime(`${startDateISO}T00:00:00`, TZ),
    monthEnd: fromZonedTime(`${endDateISO}T00:00:00`, TZ),
  };
}

/**
 * 管理側（owner/admin）が任意のセラピストの「月間出勤 + 予約件数 + 今月の稼ぎ」を
 * まとめて取得する。RLS 上 owner/admin は全件見えるため therapist_id を明示的に絞る。
 */
export async function getTherapistMonthOverview(params: {
  slug: string;
  monthISO: string;
}): Promise<OverviewOutcome> {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_reservations")) {
    return { kind: "forbidden" };
  }
  if (!MONTH_RE.test(params.monthISO)) {
    return { kind: "not_found" };
  }
  const { startDateISO, endDateISO, monthStart, monthEnd } = monthBounds(params.monthISO);
  const sql = getClient();

  return withUser<OverviewOutcome>(sql, session, async (tx) => {
    const trows = await tx<{ id: string; slug: string; name: string | null }[]>`
      select t.id, t.slug, er.published->>'name' as name
      from therapists t
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      where t.slug = ${params.slug}
      limit 1
    `;
    const t = trows[0];
    if (!t) return { kind: "not_found" };

    const shifts = await tx<
      { work_date: string; start_at: Date; end_at: Date; is_day_off: boolean }[]
    >`
      select to_char(work_date, 'YYYY-MM-DD') as work_date, start_at, end_at, is_day_off
      from shifts
      where therapist_id = ${t.id}::uuid
        and work_date >= ${startDateISO}::date and work_date < ${endDateISO}::date
    `;

    const counts = await tx<{ d: string; n: number }[]>`
      select to_char(start_at at time zone ${TZ}, 'YYYY-MM-DD') as d, count(*)::int as n
      from reservations
      where therapist_id = ${t.id}::uuid
        and start_at >= ${monthStart} and start_at < ${monthEnd}
        and status not in ('held', 'cancelled', 'noshow')
      group by 1
    `;
    const countByDay = new Map(counts.map((c) => [c.d, c.n]));

    const days: OverviewDay[] = shifts.map((s) => ({
      dateISO: s.work_date,
      hasShift: true,
      isDayOff: s.is_day_off,
      startHHmm: s.is_day_off ? null : formatInTimeZone(s.start_at, TZ, "HH:mm"),
      endHHmm: s.is_day_off ? null : formatInTimeZone(s.end_at, TZ, "HH:mm"),
      reservationCount: countByDay.get(s.work_date) ?? 0,
    }));
    const shiftDaySet = new Set(shifts.map((s) => s.work_date));
    for (const [d, n] of countByDay) {
      if (!shiftDaySet.has(d)) {
        days.push({
          dateISO: d,
          hasShift: false,
          isDayOff: false,
          startHHmm: null,
          endHHmm: null,
          reservationCount: n,
        });
      }
    }
    days.sort((a, b) => a.dateISO.localeCompare(b.dateISO));

    const cat = await tx<{ category: string; total: number }[]>`
      select category::text as category, sum(amount)::int as total
      from payout_lines
      where therapist_id = ${t.id}::uuid
        and business_date >= ${startDateISO}::date and business_date < ${endDateISO}::date
      group by category
    `;
    const byCategory = cat
      .map((c) => ({
        category: c.category,
        label: PAYOUT_CATEGORY_LABELS[c.category] ?? c.category,
        amount: c.total,
      }))
      .sort((a, b) => b.amount - a.amount);
    const monthTotal = byCategory.reduce((s, c) => s + c.amount, 0);

    return {
      kind: "ok",
      data: {
        therapistSlug: t.slug,
        displayName: t.name ?? t.slug,
        monthISO: params.monthISO,
        days,
        shiftDays: shifts.filter((s) => !s.is_day_off).length,
        reservationTotal: [...countByDay.values()].reduce((s, n) => s + n, 0),
        earnings: { monthTotal, byCategory },
      },
    };
  });
}
