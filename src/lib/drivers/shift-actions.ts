'use server';

/**
 * ドライバー週次シフト Server Actions（設計 4.3）。
 * 参照 = manage_reservations、書込 = manage_cms。時刻は純関数で分換算。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import {
  mondayOf, dowOfDate, parseDayTime, formatDayTime,
} from '@/domain/dispatch/driver-shifts';

export interface ActionResult<T = void> { ok: boolean; data?: T; error?: string; }

export interface ShiftDay { dow: number; start: string; end: string; }
export interface DriverWeek { weekStart: string; memo: string; days: ShiftDay[]; }
export interface ActiveDriver {
  id: string; name: string; vehicleColorHex: string | null;
  vehicleColorName: string | null; vehicleNumber: string | null; start: string; end: string;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const saveSchema = z.object({
  driverId: z.string().uuid(),
  weekStart: DATE,
  memo: z.string().max(2000).optional(),
  days: z.array(z.object({
    dow: z.number().int().min(0).max(6),
    start: z.string(),
    end: z.string(),
  })).max(7),
});

export async function getDriverWeek(driverId: string, weekStartISO: string): Promise<ActionResult<DriverWeek>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!DATE.safeParse(weekStartISO).success) return { ok: false, error: '日付が不正です' };
  const weekStart = mondayOf(weekStartISO);
  const sql = getClient();
  try {
    return await withUser(sql, session, async (tx) => {
      const weeks = await tx<{ id: string; memo: string | null }[]>`
        select id, memo from driver_shift_weeks
        where driver_id = ${driverId}::uuid and week_start = ${weekStart}::date
      `;
      if (weeks[0]) {
        const days = await tx<{ dow: number; start_min: number; end_min: number }[]>`
          select dow, start_min, end_min from driver_shift_days
          where week_id = ${weeks[0].id}::uuid order by dow asc
        `;
        return { ok: true, data: {
          weekStart, memo: weeks[0].memo ?? '',
          days: days.map((d) => ({ dow: d.dow, start: formatDayTime(d.start_min), end: formatDayTime(d.end_min) })),
        } };
      }
      // 引き継ぎ: 直近の過去週の memo
      const prior = await tx<{ memo: string | null }[]>`
        select memo from driver_shift_weeks
        where driver_id = ${driverId}::uuid and week_start < ${weekStart}::date
        order by week_start desc limit 1
      `;
      return { ok: true, data: { weekStart, memo: prior[0]?.memo ?? '', days: [] } };
    });
  } catch (e) {
    console.error('getDriverWeek failed:', e);
    return { ok: false, error: 'シフトの取得に失敗しました' };
  }
}

export async function saveDriverWeek(input: z.input<typeof saveSchema>): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  const d = parsed.data;
  const weekStart = mondayOf(d.weekStart);
  // 時刻を分へ。不正/逆転は弾く。
  const days: { dow: number; startMin: number; endMin: number }[] = [];
  for (const day of d.days) {
    const s = parseDayTime(day.start); const e = parseDayTime(day.end);
    if (s === null || e === null || e <= s) return { ok: false, error: `曜日${day.dow}の時刻が不正です` };
    days.push({ dow: day.dow, startMin: s, endMin: e });
  }
  const sql = getClient();
  try {
    await withUser(sql, session, async (tx) => {
      const w = await tx<{ id: string }[]>`
        insert into driver_shift_weeks (driver_id, week_start, memo)
        values (${d.driverId}::uuid, ${weekStart}::date, ${d.memo ?? null})
        on conflict (driver_id, week_start) do update set memo = excluded.memo
        returning id
      `;
      const weekId = w[0]!.id;
      await tx`delete from driver_shift_days where week_id = ${weekId}::uuid`;
      for (const day of days) {
        await tx`
          insert into driver_shift_days (week_id, dow, start_min, end_min)
          values (${weekId}::uuid, ${day.dow}, ${day.startMin}, ${day.endMin})
        `;
      }
    });
    revalidatePath('/admin/drivers');
    return { ok: true };
  } catch (e) {
    console.error('saveDriverWeek failed:', e);
    return { ok: false, error: 'シフトの保存に失敗しました' };
  }
}

export async function copyPreviousWeek(driverId: string, weekStartISO: string): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  if (!z.string().uuid().safeParse(driverId).success) return { ok: false, error: 'IDが不正です' };
  if (!DATE.safeParse(weekStartISO).success) return { ok: false, error: '日付が不正です' };
  const weekStart = mondayOf(weekStartISO);
  const sql = getClient();
  try {
    const prior = await withUser(sql, session, async (tx) => {
      const w = await tx<{ id: string; memo: string | null }[]>`
        select id, memo from driver_shift_weeks
        where driver_id = ${driverId}::uuid and week_start < ${weekStart}::date
        order by week_start desc limit 1
      `;
      if (!w[0]) return null;
      const days = await tx<{ dow: number; start_min: number; end_min: number }[]>`
        select dow, start_min, end_min from driver_shift_days where week_id = ${w[0].id}::uuid
      `;
      return { memo: w[0].memo, days };
    });
    if (!prior) return { ok: false, error: '前週のシフトがありません' };
    return await saveDriverWeek({
      driverId, weekStart,
      memo: prior.memo ?? undefined,
      days: prior.days.map((d) => ({ dow: d.dow, start: formatDayTime(d.start_min), end: formatDayTime(d.end_min) })),
    });
  } catch (e) {
    console.error('copyPreviousWeek failed:', e);
    return { ok: false, error: '前週コピーに失敗しました' };
  }
}

export async function listActiveDriversForDate(dateISO: string): Promise<ActionResult<ActiveDriver[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!DATE.safeParse(dateISO).success) return { ok: false, error: '日付が不正です' };
  const weekStart = mondayOf(dateISO);
  const dow = dowOfDate(dateISO);
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string; name: string; vehicle_color_hex: string | null;
        vehicle_color_name: string | null; vehicle_number: string | null;
        start_min: number; end_min: number;
      }[]>`
        select dr.id, dr.name, dr.vehicle_color_hex, dr.vehicle_color_name, dr.vehicle_number,
               dsd.start_min, dsd.end_min
        from drivers dr
        join driver_shift_weeks dsw on dsw.driver_id = dr.id and dsw.week_start = ${weekStart}::date
        join driver_shift_days  dsd on dsd.week_id = dsw.id and dsd.dow = ${dow}
        where dr.is_active = true
        order by dsd.start_min asc, dr.sort_order asc, dr.name asc
      `;
    });
    return { ok: true, data: rows.map((r) => ({
      id: r.id, name: r.name, vehicleColorHex: r.vehicle_color_hex,
      vehicleColorName: r.vehicle_color_name, vehicleNumber: r.vehicle_number,
      start: formatDayTime(r.start_min), end: formatDayTime(r.end_min),
    })) };
  } catch (e) {
    console.error('listActiveDriversForDate failed:', e);
    return { ok: false, error: '当日出勤ドライバーの取得に失敗しました' };
  }
}
