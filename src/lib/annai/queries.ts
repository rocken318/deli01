import "server-only";
import type { TransactionSql } from "postgres";
import { formatInTimeZone } from "date-fns-tz";
import type { BoardInput, JobItem, AttendanceState } from "@/domain/annai";

const TZ = "Asia/Tokyo";

interface ResRow {
  therapist_id: string;
  slug: string;
  name: string | null;
  clock_in_at: Date | null;
  clock_out_at: Date | null;
  shift_start: Date | null;
  shift_end: Date | null;
  res_id: string | null;
  status: string | null;
  start_at: Date | null;
  end_at: Date | null;
  depart_at: Date | null;
  free_at: Date | null;
  total_amount: number | null;
}

/**
 * 当日（JST）の全 active セラピストについて、shift/attendance と
 * done/upcoming 予約を集約して BoardInput[] を返す。RLS 下で呼ぶこと。
 */
export async function listAnnaiBoardCore(tx: TransactionSql, nowMs: number): Promise<BoardInput[]> {
  const wd = formatInTimeZone(new Date(nowMs), TZ, "yyyy-MM-dd");
  const rows = await tx<ResRow[]>`
    select
      t.id as therapist_id, t.slug as slug,
      coalesce(er.published ->> 'name', er.draft ->> 'name') as name,
      a.clock_in_at, a.clock_out_at,
      s.start_at as shift_start, s.end_at as shift_end,
      r.id as res_id, r.status::text as status,
      r.start_at, r.end_at, r.depart_at, r.free_at, r.total_amount
    from therapists t
    left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
    left join attendances a on a.therapist_id = t.id and a.work_date = ${wd}
    left join shifts s on s.therapist_id = t.id and s.work_date = ${wd} and s.is_day_off = false
    left join reservations r
      on r.therapist_id = t.id
     and (r.start_at at time zone ${TZ})::date = ${wd}::date
     and r.status in ('confirmed','enroute','in_service','done')
    where t.status = 'active'
    order by t.display_order, r.start_at nulls last
  `;

  // 集約（状態は全行を見てから決める＝当日予約があれば出勤中扱い）
  interface Acc extends BoardInput {
    _clockIn: boolean;
    _clockOut: boolean;
    _hasShift: boolean;
  }
  const byTherapist = new Map<string, Acc>();
  for (const row of rows) {
    let b = byTherapist.get(row.therapist_id);
    if (!b) {
      b = {
        therapistId: row.therapist_id,
        slug: row.slug,
        name: row.name ?? row.slug,
        attendanceState: "off",
        shiftStart: row.shift_start,
        shiftEnd: row.shift_end,
        lateManual: false,
        done: [],
        upcoming: [],
        _clockIn: row.clock_in_at !== null,
        _clockOut: row.clock_out_at !== null,
        _hasShift: row.shift_start !== null,
      };
      byTherapist.set(row.therapist_id, b);
    }
    if (row.res_id && row.start_at && row.end_at && row.depart_at && row.free_at) {
      const job: JobItem = {
        id: row.res_id,
        startAt: row.start_at,
        endAt: row.end_at,
        departAt: row.depart_at,
        freeAt: row.free_at,
        totalAmount: row.total_amount ?? 0,
        status: row.status ?? "",
      };
      if (row.status === "done") b.done.push(job);
      else b.upcoming.push(job);
    }
  }

  const out: BoardInput[] = [];
  for (const b of byTherapist.values()) {
    const hasJobs = b.done.length > 0 || b.upcoming.length > 0;
    const state: AttendanceState = b._clockOut
      ? "done"
      : b._clockIn || b._hasShift || hasJobs
        ? "working"
        : "off";
    if (state === "off" && !hasJobs) continue; // 当日 何も無い子は板に出さない
    out.push({
      therapistId: b.therapistId,
      slug: b.slug,
      name: b.name,
      attendanceState: state,
      shiftStart: b.shiftStart,
      shiftEnd: b.shiftEnd,
      lateManual: b.lateManual,
      done: b.done,
      upcoming: b.upcoming,
    });
  }
  return out;
}
