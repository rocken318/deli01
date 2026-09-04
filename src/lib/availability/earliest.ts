import "server-only";
import { getClient } from "@/lib/db-client";
import {
  addDaysISO,
  computeAvailableSlots,
  operatingDayISO,
  slotTimeLabel,
} from "@/domain/availability";
import type {
  AvailabilityInput,
  BufferSettings,
  TimeModifier,
  WalkSettings,
} from "@/domain/availability";
import {
  areaPlace,
  buildTravelDataSource,
  loadActiveReservations,
  loadLeadTimeMin,
} from "./reservation-data";

/**
 * 「最短で案内できる時間」の公開側読み取り（フェーズ9 / spec 5-4）。
 *
 * 空き枠エンジン（純粋関数）に DB の設定値を渡して now 起点で回し、最初の
 * 1件の開始時刻を返す。トップ・一覧・個人ページの EarliestSlot の time に
 * 差し込む値。本フェーズは最小配線（個人ページ）。一覧・エリア指定 UI は
 * フェーズ10 で本格化する。
 *
 * 概算の割り切り（spec 5-4「代表エリアを仮定して概算」）:
 * - エリア未指定時は、その日の shift_areas の先頭（sort_order 順）を代表エリア
 *   とし、assumed=true を返す。表示側が「〇〇区の場合」と条件を明記する。
 * - 目的地はエリア代表点（areas.center）。個別住所の確定計算はフェーズ11 の
 *   注文フローで行う。
 * - 待機場所→エリアの車移動はマトリクスでなく距離×係数の暫定値
 *   （bases はエリアを持たないため。provisionalCarMinutes 経路）。
 * - 既存予約・仮押さえはフェーズ11 で反映する（本フェーズは空で回す =
 *   シフトと移動時間だけから出る概算）。
 * - 今日に枠が無ければ翌日まで探す（それ以降はフェーズ10 の一覧で扱う）。
 */

/** EarliestSlot（公開側）へ渡す値 */
export interface EarliestSlotInfo {
  /** 開始時刻 "HH:mm"（Asia/Tokyo） */
  time: string;
  /** 営業日（Asia/Tokyo の "YYYY-MM-DD"） */
  dateISO: string;
  /** 概算に使ったエリア。「〇〇区の場合」の表示に使う（spec 5-4） */
  areaId: string;
  areaName: string;
  /** エリア未指定で代表エリアを仮定した概算なら true */
  assumed: boolean;
}

interface TherapistRow {
  id: string;
  can_use_car: boolean;
  walk_cap_meters: number | null;
}

interface ShiftRow {
  id: string;
  start_at: Date;
  end_at: Date;
  max_bookings: number | null;
  base_start_id: string | null;
  base_end_id: string | null;
}

interface AreaRow {
  id: string;
  name: string;
}

interface ModifierRow {
  time_from: string;
  time_to: string;
  multiplier: number;
  additional: number;
}

interface BufferRow {
  arrive_min: number;
  parking_min: number;
  before_min: number;
  after_min: number;
}

/** spec 5-1・5-2 の既定値（walk_settings / travel_buffers が未投入でも動く） */
const FALLBACK_WALK: WalkSettings = { detourFactor: 1.3, speedMPerMin: 80, capMeters: 1600 };
const FALLBACK_BUFFERS: BufferSettings = {
  arriveMin: 10,
  parkingMin: 15,
  beforeMin: 5,
  afterMin: 10,
};

function toBuffers(row: BufferRow | undefined): BufferSettings | null {
  if (!row) return null;
  return {
    arriveMin: row.arrive_min,
    parkingMin: row.parking_min,
    beforeMin: row.before_min,
    afterMin: row.after_min,
  };
}

/**
 * 公開中セラピストの最短案内時刻。無ければ null（EarliestSlot は placeholder を出す）。
 * areaId 指定時はそのエリアで確定計算（対応エリア外なら null）。未指定は代表エリア概算。
 */
export async function earliestSlotForTherapist(
  slug: string,
  opts: { areaId?: string | null; serviceMinutes?: number; now?: Date } = {},
): Promise<EarliestSlotInfo | null> {
  const sql = getClient();
  const now = opts.now ?? new Date();

  const therapists = await sql<TherapistRow[]>`
    select t.id, t.can_use_car, t.walk_cap_meters
    from therapists t
    join entity_records r on r.entity = 'therapist' and r.slug = t.slug
    where t.slug = ${slug} and t.status = 'active' and r.published is not null
    limit 1
  `;
  const therapist = therapists[0];
  if (!therapist) return null;

  const [walkRows, defaultBufferRows, modifierRows, courseRows, leadTimeMin] = await Promise.all([
    sql<{ detour_factor: number; speed_m_per_min: number; cap_meters: number }[]>`
      select detour_factor::float8, speed_m_per_min, cap_meters from walk_settings limit 1
    `,
    sql<BufferRow[]>`
      select arrive_min, parking_min, before_min, after_min
      from travel_buffers where scope = 'default' limit 1
    `,
    sql<ModifierRow[]>`
      select time_from::text, time_to::text, multiplier::float8, additional
      from travel_time_modifiers order by sort_order asc
    `,
    sql<{ min_duration: number | null }[]>`
      select min(duration_min)::int as min_duration from courses where is_active = true
    `,
    loadLeadTimeMin(sql),
  ]);

  const walkSettings: WalkSettings = walkRows[0]
    ? {
        detourFactor: walkRows[0].detour_factor,
        speedMPerMin: walkRows[0].speed_m_per_min,
        capMeters: walkRows[0].cap_meters,
      }
    : FALLBACK_WALK;
  const bufferDefaults = toBuffers(defaultBufferRows[0]) ?? FALLBACK_BUFFERS;
  const timeModifiers: TimeModifier[] = modifierRows.map((m) => ({
    timeFrom: m.time_from,
    timeTo: m.time_to,
    multiplier: m.multiplier,
    additional: m.additional,
  }));
  const serviceMinutes = opts.serviceMinutes ?? courseRows[0]?.min_duration ?? 60;

  // 営業日 → 翌営業日の順で最初の枠を探す（深夜も当営業日を先に / spec 5-4）
  const today = operatingDayISO(now);
  for (const dateISO of [today, addDaysISO(today, 1)]) {
    const info = await earliestForDate(sql, {
      therapist,
      dateISO,
      now,
      requestedAreaId: opts.areaId ?? null,
      serviceMinutes,
      walkSettings,
      bufferDefaults,
      timeModifiers,
      leadTimeMin,
    });
    if (info) return info;
  }
  return null;
}

async function earliestForDate(
  sql: ReturnType<typeof getClient>,
  params: {
    therapist: TherapistRow;
    dateISO: string;
    now: Date;
    requestedAreaId: string | null;
    serviceMinutes: number;
    walkSettings: WalkSettings;
    bufferDefaults: BufferSettings;
    timeModifiers: TimeModifier[];
    leadTimeMin: number;
  },
): Promise<EarliestSlotInfo | null> {
  const shifts = await sql<ShiftRow[]>`
    select id, start_at, end_at, max_bookings, base_start_id, base_end_id
    from shifts
    where therapist_id = ${params.therapist.id}::uuid
      and work_date = ${params.dateISO}
      and is_day_off = false
    limit 1
  `;
  const shift = shifts[0];
  if (!shift) return null;

  const areas = await sql<AreaRow[]>`
    select a.id, a.name
    from shift_areas sa
    join areas a on a.id = sa.area_id and a.is_active = true
    where sa.shift_id = ${shift.id}::uuid
    order by a.sort_order asc, a.name asc
  `;
  if (areas.length === 0) return null;

  // エリア指定があれば対応エリア内でのみ計算。未指定は先頭を代表エリアに（概算）
  const requested = params.requestedAreaId
    ? areas.find((a) => a.id === params.requestedAreaId)
    : undefined;
  if (params.requestedAreaId && !requested) return null;
  const destArea = requested ?? areas[0]!;
  const assumed = !requested;

  // 既存予約・仮押さえ（フェーズ11〜。期限切れホールドは除外済み）
  const engineReservations = await loadActiveReservations(sql, {
    therapistId: params.therapist.id,
    windowStartAt: shift.start_at,
    windowEndAt: shift.end_at,
  });

  const destination = areaPlace(destArea.id);

  // 距離（待機場所・既存予約エリア ↔ 目的地）と車マトリクスを一括で解決
  const travel = await buildTravelDataSource(sql, {
    destAreaId: destArea.id,
    destPlaceId: destination.id,
    baseStartId: shift.base_start_id,
    baseEndId: shift.base_end_id,
    reservationAreaIds: engineReservations
      .map((r) => r.place.areaId)
      .filter((id): id is string => id !== null),
  });

  const overrideRows = await sql<BufferRow[]>`
    select arrive_min, parking_min, before_min, after_min
    from travel_buffers where scope = 'area' and area_id = ${destArea.id}::uuid
    limit 1
  `;

  const input: AvailabilityInput = {
    therapist: {
      canUseCar: params.therapist.can_use_car,
      walkCapMeters: params.therapist.walk_cap_meters ?? params.walkSettings.capMeters,
    },
    serviceMinutes: params.serviceMinutes,
    destination: { place: destination, kind: "residence" },
    shift: {
      startAt: shift.start_at,
      endAt: shift.end_at,
      baseStart: { id: `base:${shift.base_start_id ?? "start"}`, areaId: null },
      baseEnd: { id: `base:${shift.base_end_id ?? "end"}`, areaId: null },
      areaIds: areas.map((a) => a.id),
      maxBookings: shift.max_bookings,
    },
    // 場所つきで reservations に渡す（engine の R-3 契約）
    reservations: engineReservations,
    now: params.now,
    leadTimeMin: params.leadTimeMin,
    walkSettings: params.walkSettings,
    timeModifiers: params.timeModifiers,
    bufferDefaults: params.bufferDefaults,
    bufferOverride: toBuffers(overrideRows[0]),
    travel,
  };

  const slots = computeAvailableSlots(input);
  const first = slots[0];
  if (!first) return null;
  return {
    time: slotTimeLabel(first),
    dateISO: params.dateISO,
    areaId: destArea.id,
    areaName: destArea.name,
    assumed,
  };
}
