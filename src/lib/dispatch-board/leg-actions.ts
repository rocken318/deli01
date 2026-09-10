'use server';

/**
 * 配車脚（送り車/帰り車）の割当・状態・終了・当日取得（設計 4.6/4.7）。
 * 権限: manage_reservations（owner/admin/reception）。
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { addDays } from 'date-fns';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import {
  initialStateForSlot, isValidState, isDoneState, kindForSlot, type LegSlot,
} from '@/domain/dispatch/leg-states';

const APP_TZ = 'Asia/Tokyo';
export interface ActionResult<T = void> { ok: boolean; data?: T; error?: string; }

export interface LegView {
  id: string; driverId: string | null; driverName: string | null;
  vehicleColorHex: string | null; vehicleColorName: string | null;
  vehicleNumber: string | null; state: string; isFinished: boolean;
}
export interface ReservationLegs {
  reservationId: string; send: LegView | null; return: LegView | null; allFinished: boolean;
}

const slotSchema = z.enum(['send', 'return']);
const DATE = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);

function revalidate() {
  revalidatePath('/admin/dispatch-board');
  revalidatePath('/admin/annai');
}

export async function assignLegDriver(input: {
  reservationId: string; slot: LegSlot; driverId: string;
}): Promise<ActionResult<{ legId: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  const parsed = z.object({
    reservationId: z.string().uuid(), slot: slotSchema, driverId: z.string().uuid(),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };
  const { reservationId, slot, driverId } = parsed.data;
  const kind = kindForSlot(slot);
  const initState = initialStateForSlot(slot);
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      const r = await tx<{ therapist_id: string; start_at: Date }[]>`
        select therapist_id, start_at from reservations where id = ${reservationId}::uuid`;
      if (!r[0]) return [];
      const workDate = formatInTimeZone(r[0].start_at, APP_TZ, 'yyyy-MM-dd');
      return tx<{ id: string }[]>`
        insert into dispatch_legs (kind, reservation_id, therapist_id, work_date, driver_id, state)
        values (${kind}::dispatch_leg_kind, ${reservationId}::uuid, ${r[0].therapist_id}::uuid,
                ${workDate}::date, ${driverId}::uuid, ${initState})
        on conflict (reservation_id, kind) do update
          set driver_id = excluded.driver_id, state = excluded.state, is_finished = false, finished_at = null
        returning id`;
    });
    if (!rows[0]) return { ok: false, error: '予約が見つかりません' };
    revalidate();
    return { ok: true, data: { legId: rows[0].id } };
  } catch (e) {
    console.error('assignLegDriver failed:', e);
    return { ok: false, error: 'ドライバー割当に失敗しました' };
  }
}

export async function setLegState(input: {
  legId: string; slot: LegSlot; state: string;
}): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  const parsed = z.object({
    legId: z.string().uuid(), slot: slotSchema, state: z.string(),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };
  if (!isValidState(parsed.data.slot, parsed.data.state)) {
    return { ok: false, error: 'この状態は選べません' };
  }
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update dispatch_legs set state = ${parsed.data.state}
        where id = ${parsed.data.legId}::uuid returning id`;
    });
    if (!rows[0]) return { ok: false, error: '脚が見つかりません' };
    revalidate();
    return { ok: true };
  } catch (e) {
    console.error('setLegState failed:', e);
    return { ok: false, error: '状態の更新に失敗しました' };
  }
}

export async function clearLegDriver(input: { legId: string }): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!z.string().uuid().safeParse(input.legId).success) return { ok: false, error: 'IDが不正です' };
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update dispatch_legs set driver_id = null where id = ${input.legId}::uuid returning id`;
    });
    if (!rows[0]) return { ok: false, error: '脚が見つかりません' };
    revalidate();
    return { ok: true };
  } catch (e) {
    console.error('clearLegDriver failed:', e);
    return { ok: false, error: '割当解除に失敗しました' };
  }
}

export async function finishReservation(input: { reservationId: string }): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!z.string().uuid().safeParse(input.reservationId).success) return { ok: false, error: 'IDが不正です' };
  const sql = getClient();
  try {
    const result = await withUser(sql, session, async (tx) => {
      const legs = await tx<{ id: string; state: string }[]>`
        select id, state from dispatch_legs
        where reservation_id = ${input.reservationId}::uuid and kind in ('reservation_send','reservation_return')`;
      if (legs.length === 0) return 'no_legs';
      if (!legs.every((l) => isDoneState(l.state))) return 'not_done';
      await tx`
        update dispatch_legs set is_finished = true, finished_at = now()
        where reservation_id = ${input.reservationId}::uuid and kind in ('reservation_send','reservation_return')`;
      return 'ok';
    });
    if (result === 'no_legs') return { ok: false, error: '配車がありません' };
    if (result === 'not_done') return { ok: false, error: '送り車・帰り車が完了していません' };
    revalidate();
    return { ok: true };
  } catch (e) {
    console.error('finishReservation failed:', e);
    return { ok: false, error: '終了処理に失敗しました' };
  }
}

export async function getDispatchLegs(
  dateISO: string, includeFinished = false,
): Promise<ActionResult<ReservationLegs[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!DATE.safeParse(dateISO).success) return { ok: false, error: '日付が不正です' };
  const dayStart = fromZonedTime(`${dateISO}T00:00:00`, APP_TZ);
  const dayEnd = addDays(dayStart, 1);
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string; kind: string; reservation_id: string; state: string; is_finished: boolean;
        driver_id: string | null; driver_name: string | null;
        vehicle_color_hex: string | null; vehicle_color_name: string | null; vehicle_number: string | null;
      }[]>`
        select l.id, l.kind::text, l.reservation_id, l.state, l.is_finished,
               l.driver_id, dr.name as driver_name,
               dr.vehicle_color_hex, dr.vehicle_color_name, dr.vehicle_number
        from dispatch_legs l
        left join drivers dr on dr.id = l.driver_id
        where l.work_date = ${dateISO}::date
          and l.kind in ('reservation_send','reservation_return')
          and l.reservation_id is not null`;
    });
    // dayStart/dayEnd は将来の跨ぎ対応の布石（現状 work_date で十分）。未使用回避のため参照。
    void dayStart; void dayEnd;
    const byRes = new Map<string, ReservationLegs>();
    for (const r of rows) {
      const key = r.reservation_id;
      const entry = byRes.get(key) ?? { reservationId: key, send: null, return: null, allFinished: false };
      const view: LegView = {
        id: r.id, driverId: r.driver_id, driverName: r.driver_name,
        vehicleColorHex: r.vehicle_color_hex, vehicleColorName: r.vehicle_color_name,
        vehicleNumber: r.vehicle_number, state: r.state, isFinished: r.is_finished,
      };
      if (r.kind === 'reservation_send') entry.send = view;
      else entry.return = view;
      byRes.set(key, entry);
    }
    const list: ReservationLegs[] = [];
    for (const entry of byRes.values()) {
      const legs = [entry.send, entry.return].filter((x): x is LegView => x !== null);
      entry.allFinished = legs.length > 0 && legs.every((l) => l.isFinished);
      if (!includeFinished && entry.allFinished) continue;
      list.push(entry);
    }
    return { ok: true, data: list };
  } catch (e) {
    console.error('getDispatchLegs failed:', e);
    return { ok: false, error: '配車脚の取得に失敗しました' };
  }
}
