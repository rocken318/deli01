import "server-only";
import type { TransactionSql } from "postgres";
import { formatInTimeZone } from "date-fns-tz";

export interface AttendanceRecord {
  id: string;
  therapistId: string;
  workDate: string; // YYYY-MM-DD（JST）
  clockInAt: Date | null;
  clockOutAt: Date | null;
  status: "working" | "done";
}

const TZ = "Asia/Tokyo";

function jstDate(nowMs: number): string {
  return formatInTimeZone(new Date(nowMs), TZ, "yyyy-MM-dd");
}

interface AttendanceDbRow {
  id: string;
  therapist_id: string;
  work_date: string;
  clock_in_at: Date | null;
  clock_out_at: Date | null;
  status: "working" | "done";
}

function mapRow(r: AttendanceDbRow): AttendanceRecord {
  return {
    id: r.id,
    therapistId: r.therapist_id,
    // work_date は ::text で取得しているので文字列。念のため Date が来ても JST 日付へ。
    workDate:
      typeof r.work_date === "string"
        ? r.work_date
        : formatInTimeZone(new Date(r.work_date as unknown as string), TZ, "yyyy-MM-dd"),
    clockInAt: r.clock_in_at,
    clockOutAt: r.clock_out_at,
    status: r.status,
  };
}

/** 当日（JST）の自分の実績を1件返す（無ければ null）。RLS 下で呼ぶこと。 */
export async function getTodayAttendanceCore(
  tx: TransactionSql,
  therapistId: string,
  nowMs: number,
): Promise<AttendanceRecord | null> {
  const wd = jstDate(nowMs);
  const rows = await tx<AttendanceDbRow[]>`
    select id, therapist_id, work_date::text as work_date, clock_in_at, clock_out_at, status
    from attendances
    where therapist_id = ${therapistId} and work_date = ${wd}
    limit 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * 打刻。clock_in は行を upsert して clock_in_at を「未設定のときだけ」入れる（冪等）。
 * clock_out は clock_out_at を「未設定のときだけ」入れて status='done'（冪等）。
 * RLS 下で呼ぶこと（本人 therapist_id のみ通る）。
 */
export async function punchAttendanceCore(
  tx: TransactionSql,
  therapistId: string,
  action: "clock_in" | "clock_out",
  nowMs: number,
): Promise<AttendanceRecord> {
  const wd = jstDate(nowMs);
  const now = new Date(nowMs);

  if (action === "clock_in") {
    await tx`
      insert into attendances (therapist_id, work_date, clock_in_at, status)
      values (${therapistId}, ${wd}, ${now}, 'working')
      on conflict (therapist_id, work_date) do update
        set clock_in_at = coalesce(attendances.clock_in_at, excluded.clock_in_at)
    `;
  } else {
    await tx`
      insert into attendances (therapist_id, work_date, clock_in_at, clock_out_at, status)
      values (${therapistId}, ${wd}, ${now}, ${now}, 'done')
      on conflict (therapist_id, work_date) do update
        set clock_out_at = coalesce(attendances.clock_out_at, excluded.clock_out_at),
            clock_in_at  = coalesce(attendances.clock_in_at, excluded.clock_in_at),
            status = 'done'
    `;
  }

  const rec = await getTodayAttendanceCore(tx, therapistId, nowMs);
  if (!rec) throw new Error("attendance upsert failed");
  return rec;
}

export interface DiffRow {
  therapistId: string;
  slug: string;
  name: string;
  planStartAt: Date | null;
  planEndAt: Date | null;
  clockInAt: Date | null;
  clockOutAt: Date | null;
}

interface DiffDbRow {
  therapist_id: string;
  slug: string;
  name: string | null;
  plan_start_at: Date | null;
  plan_end_at: Date | null;
  clock_in_at: Date | null;
  clock_out_at: Date | null;
}

/** 当日（JST）の全セラピストの 予定(shift) と 実績(attendance) を突き合わせて返す。 */
export async function listTodayDiffCore(tx: TransactionSql, nowMs: number): Promise<DiffRow[]> {
  const wd = jstDate(nowMs);
  const rows = await tx<DiffDbRow[]>`
    select
      t.id as therapist_id,
      t.slug as slug,
      (er.draft ->> 'name') as name,
      s.start_at as plan_start_at,
      s.end_at as plan_end_at,
      a.clock_in_at as clock_in_at,
      a.clock_out_at as clock_out_at
    from therapists t
    left join entity_records er
      on er.entity = 'therapist' and er.slug = t.slug
    left join shifts s
      on s.therapist_id = t.id and s.work_date = ${wd} and s.is_day_off = false
    left join attendances a
      on a.therapist_id = t.id and a.work_date = ${wd}
    where t.status = 'active'
    order by a.clock_in_at nulls last, s.start_at nulls last, t.display_order
  `;
  return rows.map((r) => ({
    therapistId: r.therapist_id,
    slug: r.slug,
    name: r.name ?? r.slug,
    planStartAt: r.plan_start_at,
    planEndAt: r.plan_end_at,
    clockInAt: r.clock_in_at,
    clockOutAt: r.clock_out_at,
  }));
}
