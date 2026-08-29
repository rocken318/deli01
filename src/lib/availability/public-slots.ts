import "server-only";
import { getClient } from "@/lib/db-client";
import {
  addDaysISO,
  computeAvailableSlots,
  isRealDateISO,
  localDateISO,
  slotTimeLabel,
} from "@/domain/availability";
import type {
  AvailabilityInput,
  AvailableSlot,
  BufferSettings,
  PlaceRef,
  TimeModifier,
  WalkSettings,
} from "@/domain/availability";
import { totalServiceMinutes } from "@/domain/catalog";
import type { OptionDurationLike } from "@/domain/catalog";
import {
  areaPlace,
  buildTravelDataSource,
  loadActiveReservations,
} from "./reservation-data";

/**
 * 公開側の空き枠算出（フェーズ10 / spec 2-3・5-3・5-4）。
 *
 * 空き枠エンジン（純粋関数 computeAvailableSlots）に DB の設定値を渡して、
 * 指定エリア・指定コース/オプションの候補枠を返す。個人ページのエリア/コース
 * セレクタが変わるたびに**都度計算**する（キャッシュしない / spec 2-7）。
 *
 * 割り切り（earliest.ts と同じ）:
 * - 目的地はエリア代表点（areas.center）。ホテル指定時（フェーズ11）は hotels の
 *   所在地とし、extra_minutes を到着バッファに加算する（spec 8-2）。
 *   個別住所座標での再計算はジオコーディング配線後（docs/booking-holds.md）。
 * - 待機場所→エリアの車移動はマトリクスでなく距離×係数の暫定値（bases はエリアを
 *   持たないため。provisionalCarMinutes 経路）。
 * - **既存予約・仮押さえ（フェーズ11〜）**: held / confirmed（+進行中）の予約を
 *   depart_at〜free_at の占有区間として engine に渡す。期限切れホールドは除外
 *   （loadActiveReservations / spec 5-5）。
 * - L = totalServiceMinutes(コース duration + 選択オプション duration 合計 / spec 3-4・5-3)。
 *
 * ページ側は force-dynamic。ここは server-only の実行時読取に徹する。
 */

/** spec 5-1・5-2 の既定値（walk_settings / travel_buffers が未投入でも動く） */
const FALLBACK_WALK: WalkSettings = { detourFactor: 1.3, speedMPerMin: 80, capMeters: 1600 };
const FALLBACK_BUFFERS: BufferSettings = {
  arriveMin: 10,
  parkingMin: 15,
  beforeMin: 5,
  afterMin: 10,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 公開セレクタに出すコース1件（金額は整数円 / spec 3-4） */
export interface PublicCourse {
  id: string;
  name: string;
  durationMin: number;
  price: number;
  nominationFeeDefault: number;
}

/** 公開セレクタに出すオプション1件（duration_min が L に効く / spec 5-3） */
export interface PublicOption {
  id: string;
  name: string;
  description: string;
  price: number;
  durationMin: number;
}

/** 公開エリア1件（絞り込みチップ・前提表示に使う。名前は DB 由来 / spec 13-1） */
export interface PublicArea {
  id: string;
  name: string;
}

/** 個人ページの空き枠表示（帯/リスト）に渡す1枠 */
export interface PublicSlotView {
  /** 開始時刻 "HH:mm"（Asia/Tokyo） */
  time: string;
  /** ISO（UTC）文字列。クライアントで再フォーマットせず表示は time を使う */
  startAtISO: string;
}

/** getTherapistSlots の戻り（枠 + 前提エリア + メタ） */
export interface TherapistSlotsResult {
  /** 算出した候補枠（昇順） */
  slots: PublicSlotView[];
  /** 計算に使ったエリア（「〇〇区であれば案内可能」の表示に使う） */
  areaId: string;
  areaName: string;
  /** エリア未指定で代表エリアを仮定した概算なら true（spec 5-4） */
  assumed: boolean;
  /** 計算した営業日（Asia/Tokyo "YYYY-MM-DD"） */
  dateISO: string;
  /** 施術時間 L（分）= コース + オプション合計 */
  serviceMinutes: number;
  /** その日の対応エリア（絞り込みチップ用・sort_order 順） */
  areas: PublicArea[];
  /**
   * 内訳つきの生スロット（フェーズ11 の仮押さえが depart_at / free_at / 移動・
   * バッファの控えとして使う。クライアントへはそのまま渡さない）
   */
  rawSlots: AvailableSlot[];
  /** 計算対象セラピストの内部 id（仮押さえの insert に使う。空 = 未解決） */
  therapistId: string;
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

interface BufferRow {
  arrive_min: number;
  parking_min: number;
  before_min: number;
  after_min: number;
}

function toBuffers(row: BufferRow | undefined): BufferSettings | null {
  if (!row) return null;
  return {
    arriveMin: row.arrive_min,
    parkingMin: row.parking_min,
    beforeMin: row.before_min,
    afterMin: row.after_min,
  };
}

/** dateISO 未指定時に前方探索する日数（今日 + この日数分 / spec 5-4 と揃える） */
const DEFAULT_SEARCH_DAYS = 7;

/**
 * 公開中セラピストの、その日・そのエリア（またはコース/オプション）での候補枠。
 *
 * - slug が非公開・退職・不在なら null。
 * - **dateISO 指定時はその日だけ**を計算（Server Action の再計算はこの経路。
 *   出勤なし・対応エリア外は「その日は空」= slots:[]、細工日付は null）。
 * - **dateISO 未指定時は今日から前方に最初に枠が出る日を探す**（spec 5-4 の
 *   「now 起点で最初の1件」と同じ発想。今日の shift が終業後でも翌日以降で出す）。
 * - areaId 指定時はそのエリアで確定計算（対応エリア外なら null）。未指定は
 *   その日の対応エリア先頭（sort_order）を代表エリアに仮定した概算（assumed=true）。
 * - courseId 指定時はそのコース時間 + optionIds のオプション時間で L を組む。
 *   courseId 未指定は最短コースの duration を既定に使う（概算）。
 */
export async function getTherapistSlots(params: {
  slug: string;
  dateISO?: string | null;
  areaId?: string | null;
  courseId?: string | null;
  optionIds?: readonly string[];
  /** 派遣先がホテルのとき（spec 6章 手順2 / 8-2）。所在エリア・extra_minutes を使う */
  hotelId?: string | null;
  now?: Date;
}): Promise<TherapistSlotsResult | null> {
  const now = params.now ?? new Date();

  // dateISO 明示指定: その日だけ計算（Server Action の再計算はこの決定的な経路）
  if (params.dateISO != null) {
    if (!isRealDateISO(params.dateISO)) return null;
    return slotsForDate({ ...params, dateISO: params.dateISO, now });
  }

  // 未指定: 今日から前方に、最初に枠が出る日を返す（無ければ最終日の空結果）
  // 推奨3: 明示エリアでも「その日は対応外」なら次の日へ継続（earliest.ts と同じ方針）。
  // ただし「エリアを指定したが7日間どの日にも対応エリアに入っていない」場合は null を返す
  // （嘘の枠を出さない / spec 2-3 の精神を維持）。
  const today = localDateISO(now);
  let lastResult: TherapistSlotsResult | null = null;
  // エリア明示指定時: 少なくとも1日でもそのエリアを含むシフトが見つかったか
  let areaFoundOnAnyDay = false;
  for (let d = 0; d < DEFAULT_SEARCH_DAYS; d += 1) {
    const dateISO = addDaysISO(today, d);
    const res = await slotsForDate({ ...params, dateISO, now });
    if (res === null) {
      // null = その日は非公開 or 明示エリアが対応外 → 翌日以降を探す（推奨3）
      continue;
    }
    // エリアが明示指定されていて、かつ areaName が入った（対応エリア内）なら発見済み
    if (params.areaId && res.areaName) {
      areaFoundOnAnyDay = true;
    }
    lastResult = res;
    if (res.slots.length > 0) return res;
  }
  // エリア明示指定でどの日も対応エリアに入らなかった → null（嘘の枠を出さない）
  if (params.areaId && !areaFoundOnAnyDay) return null;
  return lastResult;
}

/** 派遣先ホテルの解決結果（spec 8-2） */
interface HotelRow {
  id: string;
  area_id: string | null;
  extra_minutes: number;
  is_blocked: boolean;
}

/** 単日（dateISO）での候補枠。getTherapistSlots の内部実体。 */
async function slotsForDate(params: {
  slug: string;
  dateISO: string;
  areaId?: string | null;
  courseId?: string | null;
  optionIds?: readonly string[];
  hotelId?: string | null;
  now: Date;
}): Promise<TherapistSlotsResult | null> {
  const sql = getClient();
  const now = params.now;

  const dateISO = params.dateISO;
  if (!isRealDateISO(dateISO)) return null;

  const areaFilter = params.areaId && UUID_RE.test(params.areaId) ? params.areaId : null;
  // 細工された areaId（UUID でない）で全体を概算に倒さない: 明示指定が不正なら null
  if (params.areaId && !areaFilter) return null;

  // 派遣先ホテル（spec 8-2）: is_blocked は予約不可。所在エリアが分かれば
  // それを目的地エリアとして確定し、extra_minutes を到着バッファに加算する。
  let hotel: HotelRow | null = null;
  if (params.hotelId) {
    if (!UUID_RE.test(params.hotelId)) return null;
    const hotels = await sql<HotelRow[]>`
      select id, area_id, extra_minutes, is_blocked
      from hotels where id = ${params.hotelId}::uuid
      limit 1
    `;
    hotel = hotels[0] ?? null;
    if (!hotel || hotel.is_blocked) return null;
  }
  // ホテルの所在エリアはエリア指定より優先（住所が確定している）。未設定なら
  // areaFilter / 代表エリアで概算する（仮登録ホテル / spec 8-2）
  const effectiveAreaFilter = hotel?.area_id ?? areaFilter;

  const therapists = await sql<TherapistRow[]>`
    select t.id, t.can_use_car, t.walk_cap_meters
    from therapists t
    join entity_records r on r.entity = 'therapist' and r.slug = t.slug
    where t.slug = ${params.slug} and t.status = 'active' and r.published is not null
    limit 1
  `;
  const therapist = therapists[0];
  if (!therapist) return null;

  const shifts = await sql<ShiftRow[]>`
    select id, start_at, end_at, max_bookings, base_start_id, base_end_id
    from shifts
    where therapist_id = ${therapist.id}::uuid
      and work_date = ${dateISO}
      and is_day_off = false
    limit 1
  `;
  const shift = shifts[0];
  if (!shift) {
    return emptyResult(dateISO, areaFilter, [], therapist.id);
  }

  const areas = await sql<AreaRow[]>`
    select a.id, a.name
    from shift_areas sa
    join areas a on a.id = sa.area_id and a.is_active = true
    where sa.shift_id = ${shift.id}::uuid
    order by a.sort_order asc, a.name asc
  `;
  if (areas.length === 0) {
    return emptyResult(dateISO, areaFilter, [], therapist.id);
  }

  const requested = effectiveAreaFilter
    ? areas.find((a) => a.id === effectiveAreaFilter)
    : undefined;
  // エリア明示指定が対応エリア外なら「その日その枠は無い」= null（嘘の枠を出さない / spec 2-3）
  if (effectiveAreaFilter && !requested) return null;
  const destArea = requested ?? areas[0]!;
  const assumed = !requested;

  // 施術時間 L = コース + 選択オプション（spec 3-4・5-3）
  const serviceMinutes = await resolveServiceMinutes(sql, {
    courseId: params.courseId ?? null,
    optionIds: params.optionIds ?? [],
    therapistId: therapist.id,
  });

  // 既存予約・仮押さえ（spec 5-3 手順4・5-5。期限切れホールドは除外済み）
  const engineReservations = await loadActiveReservations(sql, {
    therapistId: therapist.id,
    windowStartAt: shift.start_at,
    windowEndAt: shift.end_at,
  });

  const destination: PlaceRef = hotel
    ? { id: `hotel:${hotel.id}`, areaId: destArea.id }
    : areaPlace(destArea.id);

  const [walkRows, defaultBufferRows, modifierRows, overrideRows, travel] =
    await Promise.all([
      sql<{ detour_factor: number; speed_m_per_min: number; cap_meters: number }[]>`
        select detour_factor::float8, speed_m_per_min, cap_meters from walk_settings limit 1
      `,
      sql<BufferRow[]>`
        select arrive_min, parking_min, before_min, after_min
        from travel_buffers where scope = 'default' limit 1
      `,
      sql<
        { time_from: string; time_to: string; multiplier: number; additional: number }[]
      >`
        select time_from::text, time_to::text, multiplier::float8, additional
        from travel_time_modifiers order by sort_order asc
      `,
      sql<BufferRow[]>`
        select arrive_min, parking_min, before_min, after_min
        from travel_buffers where scope = 'area' and area_id = ${destArea.id}::uuid
        limit 1
      `,
      buildTravelDataSource(sql, {
        destAreaId: destArea.id,
        destHotelId: hotel?.id ?? null,
        destPlaceId: destination.id,
        baseStartId: shift.base_start_id,
        baseEndId: shift.base_end_id,
        reservationAreaIds: engineReservations
          .map((r) => r.place.areaId)
          .filter((id): id is string => id !== null),
      }),
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

  const input: AvailabilityInput = {
    therapist: {
      canUseCar: therapist.can_use_car,
      walkCapMeters: therapist.walk_cap_meters ?? walkSettings.capMeters,
    },
    serviceMinutes,
    destination: {
      place: destination,
      kind: hotel ? "hotel" : "residence",
      hotelExtraMinutes: hotel?.extra_minutes ?? null,
    },
    shift: {
      startAt: shift.start_at,
      endAt: shift.end_at,
      baseStart: { id: `base:${shift.base_start_id ?? "start"}`, areaId: null },
      baseEnd: { id: `base:${shift.base_end_id ?? "end"}`, areaId: null },
      areaIds: areas.map((a) => a.id),
      maxBookings: shift.max_bookings,
    },
    // 場所つきで reservations に渡す（engine の R-3 契約。holds には流さない）
    reservations: engineReservations,
    now,
    walkSettings,
    timeModifiers,
    bufferDefaults,
    bufferOverride: toBuffers(overrideRows[0]),
    travel,
  };

  const slots = computeAvailableSlots(input);
  return {
    slots: slots.map(toSlotView),
    areaId: destArea.id,
    areaName: destArea.name,
    assumed,
    dateISO,
    serviceMinutes,
    areas: areas.map((a) => ({ id: a.id, name: a.name })),
    rawSlots: slots,
    therapistId: therapist.id,
  };
}

/** 「その日は枠が無い（出勤なし/エリアなし）」の空結果。areas は対応エリア無しなので空 */
function emptyResult(
  dateISO: string,
  areaFilter: string | null,
  areas: PublicArea[],
  therapistId = "",
): TherapistSlotsResult {
  return {
    slots: [],
    areaId: areaFilter ?? "",
    areaName: "",
    assumed: !areaFilter,
    dateISO,
    serviceMinutes: 0,
    areas,
    rawSlots: [],
    therapistId,
  };
}

function toSlotView(slot: AvailableSlot): PublicSlotView {
  return { time: slotTimeLabel(slot), startAtISO: slot.startAt.toISOString() };
}

interface CourseDurationRow {
  duration_min: number;
}
interface OptionDurationRow {
  duration_min: number;
}

/**
 * L（分）= コース duration + 選択オプション duration 合計（spec 3-4・5-3）。
 * - courseId 指定: そのコースの duration。無効な id は最短コースにフォールバック。
 * - courseId 未指定: is_active な最短コースの duration（概算の既定）。
 * - optionIds: is_active・is_public、かつ option_availability で当該セラピストに
 *   対応する（行が無ければ全員対応 / spec 3-4）オプションだけを L に算入する。
 */
async function resolveServiceMinutes(
  sql: ReturnType<typeof getClient>,
  params: { courseId: string | null; optionIds: readonly string[]; therapistId: string },
): Promise<number> {
  let courseMinutes = 0;
  if (params.courseId && UUID_RE.test(params.courseId)) {
    const rows = await sql<CourseDurationRow[]>`
      select duration_min from courses
      where id = ${params.courseId}::uuid and is_active = true
      limit 1
    `;
    courseMinutes = rows[0]?.duration_min ?? 0;
  }
  if (courseMinutes === 0) {
    const rows = await sql<CourseDurationRow[]>`
      select duration_min from courses where is_active = true
      order by duration_min asc limit 1
    `;
    courseMinutes = rows[0]?.duration_min ?? 60;
  }

  const validOptionIds = (params.optionIds ?? []).filter((id) => UUID_RE.test(id));
  let optionDurations: OptionDurationLike[] = [];
  if (validOptionIds.length > 0) {
    const rows = await sql<OptionDurationRow[]>`
      select o.duration_min
      from options o
      where o.id = any(${validOptionIds}::uuid[])
        and o.is_active = true
        and o.is_public = true
        and (
          not exists (select 1 from option_availability oa where oa.option_id = o.id)
          or exists (
            select 1 from option_availability oa
            where oa.option_id = o.id and oa.therapist_id = ${params.therapistId}::uuid
          )
        )
    `;
    optionDurations = rows.map((r) => ({ durationMin: r.duration_min }));
  }

  return totalServiceMinutes(courseMinutes, optionDurations);
}

/**
 * 公開コース一覧（is_active・sort_order 順）。個人ページのコースセレクタに使う。
 * 金額はすべて整数（円）。名前は DB 由来（直書き日本語なし / spec 13-1）。
 */
export async function listPublicCourses(): Promise<PublicCourse[]> {
  const sql = getClient();
  const rows = await sql<
    {
      id: string;
      name: string;
      duration_min: number;
      price: number;
      nomination_fee_default: number;
    }[]
  >`
    select id, name, duration_min, price, nomination_fee_default
    from courses where is_active = true
    order by sort_order asc, duration_min asc
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    durationMin: r.duration_min,
    price: r.price,
    nominationFeeDefault: r.nomination_fee_default,
  }));
}

/**
 * 公開オプション一覧（is_active・is_public・sort_order 順）。
 * option_availability に行があるオプションは、当該セラピストが対応する場合のみ含める
 * （行が無ければ全員対応 / spec 3-4）。therapistId 省略時は全体（全員対応分のみ）。
 */
export async function listPublicOptions(therapistId?: string | null): Promise<PublicOption[]> {
  const sql = getClient();
  const tid = therapistId && UUID_RE.test(therapistId) ? therapistId : null;
  const rows = await sql<
    {
      id: string;
      name: string;
      description: string | null;
      price: number;
      duration_min: number;
    }[]
  >`
    select o.id, o.name, o.description, o.price, o.duration_min
    from options o
    where o.is_active = true and o.is_public = true
      and (
        not exists (select 1 from option_availability oa where oa.option_id = o.id)
        ${
          tid
            ? sql`or exists (
                select 1 from option_availability oa
                where oa.option_id = o.id and oa.therapist_id = ${tid}::uuid
              )`
            : sql``
        }
      )
    order by o.sort_order asc, o.name asc
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    price: r.price,
    durationMin: r.duration_min,
  }));
}

/** 公開セラピストの内部 id を slug から引く（オプション対応の絞り込みに使う） */
export async function getPublicTherapistId(slug: string): Promise<string | null> {
  const sql = getClient();
  const rows = await sql<{ id: string }[]>`
    select t.id
    from therapists t
    join entity_records r on r.entity = 'therapist' and r.slug = t.slug
    where t.slug = ${slug} and t.status = 'active' and r.published is not null
    limit 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * 最短で案内できる枠（spec 5-4）。earliest.ts の実装をそのまま公開側の入口として
 * 再輸出する。トップ・一覧・個人ページの EarliestSlot 用。
 */
export { earliestSlotForTherapist as getEarliestForTherapist } from "./earliest";
export type { EarliestSlotInfo } from "./earliest";
