import "server-only";
import type { Sql } from "postgres";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { APP_TIME_ZONE } from "@/domain/availability";

/**
 * キャスト用マイページの「出勤カレンダー」「予約一覧」用コアクエリ（A1）。
 *
 * すべて therapist セッションで withUser 経由 = RLS が本人分に限定する
 * （shifts_self_select / reservations の therapist 自己ポリシー）。
 * 追加の where 句で therapist_id を絞らない（RLS が唯一の真実）。
 * 電話番号・住所は返さない（一覧・カレンダーには不要）。
 */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export interface MyScheduleDay {
  /** YYYY-MM-DD（JST） */
  dateISO: string;
  hasShift: boolean;
  isDayOff: boolean;
  /** 出勤時間（HH:mm・JST）。未設定/欠勤時は null */
  startHHmm: string | null;
  endHHmm: string | null;
  reservationCount: number;
}

export interface MyReservationItem {
  reservationId: string;
  dateISO: string;
  startHHmm: string;
  endHHmm: string;
  status: string;
  courseName: string;
  areaName: string | null;
  hotelName: string | null;
}

export type MyScheduleOutcome =
  | { kind: "ok"; days: MyScheduleDay[] }
  | { kind: "forbidden" };

export type MyReservationsOutcome =
  | { kind: "ok"; items: MyReservationItem[] }
  | { kind: "forbidden" };

export interface MyServiceHistoryItem {
  reservationId: string;
  dateISO: string;
  startHHmm: string;
  courseName: string;
  areaName: string | null;
  totalAmount: number;
}

export type MyServiceHistoryOutcome =
  | { kind: "ok"; items: MyServiceHistoryItem[] }
  | { kind: "forbidden" };

/** yearMonth("YYYY-MM") の月境界（JST）と当月/翌月頭の日付文字列を返す。 */
function monthBounds(yearMonth: string): {
  startDateISO: string;
  endDateISO: string;
  monthStart: Date;
  monthEnd: Date;
} {
  const [y, m] = yearMonth.split("-").map(Number);
  const startDateISO = `${yearMonth}-01`;
  const nextY = m === 12 ? y! + 1 : y!;
  const nextM = m === 12 ? 1 : m! + 1;
  const endDateISO = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  return {
    startDateISO,
    endDateISO,
    monthStart: fromZonedTime(`${startDateISO}T00:00:00`, APP_TIME_ZONE),
    monthEnd: fromZonedTime(`${endDateISO}T00:00:00`, APP_TIME_ZONE),
  };
}

/**
 * 指定月の日別スケジュール（出勤の有無/時間 + 予約件数）を本人分だけ返す。
 */
export async function getMyMonthlyScheduleCore(
  sql: Sql,
  session: Session,
  yearMonth: string,
): Promise<MyScheduleOutcome> {
  if (session.role !== "therapist" || !session.therapistId) {
    return { kind: "forbidden" };
  }
  if (!MONTH_RE.test(yearMonth)) {
    throw new RangeError(`yearMonth は "YYYY-MM" であること: ${yearMonth}`);
  }
  const { startDateISO, endDateISO, monthStart, monthEnd } = monthBounds(yearMonth);

  return withUser<MyScheduleOutcome>(sql, session, async (tx) => {
    const shifts = await tx<
      { work_date: string; start_at: Date; end_at: Date; is_day_off: boolean }[]
    >`
      select to_char(work_date, 'YYYY-MM-DD') as work_date,
             start_at, end_at, is_day_off
      from shifts
      where work_date >= ${startDateISO}::date and work_date < ${endDateISO}::date
    `;

    const counts = await tx<{ d: string; n: number }[]>`
      select to_char(start_at at time zone ${APP_TIME_ZONE}, 'YYYY-MM-DD') as d,
             count(*)::int as n
      from reservations
      where start_at >= ${monthStart} and start_at < ${monthEnd}
      group by 1
    `;
    const countByDay = new Map(counts.map((c) => [c.d, c.n]));

    const days: MyScheduleDay[] = shifts.map((s) => ({
      dateISO: s.work_date,
      hasShift: true,
      isDayOff: s.is_day_off,
      startHHmm: s.is_day_off
        ? null
        : formatInTimeZone(s.start_at, APP_TIME_ZONE, "HH:mm"),
      endHHmm: s.is_day_off
        ? null
        : formatInTimeZone(s.end_at, APP_TIME_ZONE, "HH:mm"),
      reservationCount: countByDay.get(s.work_date) ?? 0,
    }));

    // 出勤が無い日でも予約が入っている日は表示する（イレギュラー可視化）
    const shiftDays = new Set(shifts.map((s) => s.work_date));
    for (const [d, n] of countByDay) {
      if (!shiftDays.has(d)) {
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
    return { kind: "ok", days };
  });
}

/**
 * 指定日(JST)以降の本人の予約を時系列で返す（住所・電話番号は含めない）。
 * RLS により confirmed/enroute/in_service/done のみ可視。
 */
export async function getMyReservationsCore(
  sql: Sql,
  session: Session,
  fromISO: string,
  limit = 100,
): Promise<MyReservationsOutcome> {
  if (session.role !== "therapist" || !session.therapistId) {
    return { kind: "forbidden" };
  }
  if (!DATE_RE.test(fromISO)) {
    throw new RangeError(`fromISO は "YYYY-MM-DD" であること: ${fromISO}`);
  }
  const from = fromZonedTime(`${fromISO}T00:00:00`, APP_TIME_ZONE);
  const cap = Math.min(Math.max(1, limit), 200);

  return withUser<MyReservationsOutcome>(sql, session, async (tx) => {
    const rows = await tx<
      {
        id: string;
        start_at: Date;
        end_at: Date;
        status: string;
        course_name: string;
        area_name: string | null;
        hotel_name: string | null;
      }[]
    >`
      select r.id, r.start_at, r.end_at, r.status::text as status,
             co.name as course_name,
             ar.name as area_name,
             h.name  as hotel_name
      from reservations r
      join courses co on co.id = r.course_id
      left join areas ar on ar.id = r.area_id
      left join hotels h on h.id = r.hotel_id
      where r.start_at >= ${from}
      order by r.start_at asc
      limit ${cap}
    `;

    return {
      kind: "ok",
      items: rows.map((r) => ({
        reservationId: r.id,
        dateISO: formatInTimeZone(r.start_at, APP_TIME_ZONE, "yyyy-MM-dd"),
        startHHmm: formatInTimeZone(r.start_at, APP_TIME_ZONE, "HH:mm"),
        endHHmm: formatInTimeZone(r.end_at, APP_TIME_ZONE, "HH:mm"),
        status: r.status,
        courseName: r.course_name,
        areaName: r.area_name,
        hotelName: r.hotel_name,
      })),
    };
  });
}

/**
 * 本人の「接客履歴」（過去の done 予約）を新しい順に返す。RLS で本人限定。
 */
export async function getMyServiceHistoryCore(
  sql: Sql,
  session: Session,
  limit = 100,
): Promise<MyServiceHistoryOutcome> {
  if (session.role !== "therapist" || !session.therapistId) {
    return { kind: "forbidden" };
  }
  const cap = Math.min(Math.max(1, limit), 200);

  return withUser<MyServiceHistoryOutcome>(sql, session, async (tx) => {
    const rows = await tx<
      {
        id: string;
        start_at: Date;
        course_name: string;
        area_name: string | null;
        total_amount: number;
      }[]
    >`
      select r.id, r.start_at, co.name as course_name, ar.name as area_name, r.total_amount
      from reservations r
      join courses co on co.id = r.course_id
      left join areas ar on ar.id = r.area_id
      where r.status = 'done'
      order by r.start_at desc
      limit ${cap}
    `;
    return {
      kind: "ok",
      items: rows.map((r) => ({
        reservationId: r.id,
        dateISO: formatInTimeZone(r.start_at, APP_TIME_ZONE, "yyyy-MM-dd"),
        startHHmm: formatInTimeZone(r.start_at, APP_TIME_ZONE, "HH:mm"),
        courseName: r.course_name,
        areaName: r.area_name,
        totalAmount: r.total_amount,
      })),
    };
  });
}
