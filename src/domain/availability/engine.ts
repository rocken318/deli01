/**
 * 空き枠算出エンジン（フェーズ9 / spec 5-3・5-4 ★最重要）。
 *
 * DB にも Next.js にも依存しない純粋関数。入力（シフト・既存予約・移動データ・
 * バッファ設定）はすべて呼び出し側が用意して渡す。既存予約はフェーズ11 で
 * reservations テーブルから読むが、本フェーズではテストが直接渡す。
 *
 * アルゴリズム（spec 5-3 を忠実に実装）:
 *   1. shift 無 → 空。B_start / B_end / 対応エリア / 上限本数を得る
 *   2. 目的地エリア A が対応エリアに含まれなければ空
 *   3. 上限本数に達していれば空（remainingSlots）
 *   4. 既存予約を depart_at 順に R1..Rn
 *   5. 隙間列挙: gap0(B_start→R1.depart_at) / gap_i(Ri.free_at→R(i+1).depart_at)
 *      / gap_n(Rn.free_at→B_end「帰れること」まで条件に入れる)
 *   6. 各 gap（直前地点 P・開始可能時刻 t_p・直後地点 N・締切 t_n）で開始 s の条件:
 *        s ≥ t_p + travel(P→A) + buffer_arrive（ホテルなら extra_minutes 加算）
 *        s ≥ now + 受付リードタイム（既定90分）
 *        s + buffer_before + L + buffer_after + travel(A→N) ≤ t_n
 *   7. s を15分刻みに切り上げて列挙
 *   8. held / confirmed の占有区間（depart_at〜free_at）と重複するものを除外
 *
 * 移動時間の解決（spec 5-1: 徒歩と車を同じ仕組みで扱わない）:
 *   - 距離（PostGIS の直線距離）を TravelDataSource が返し、engine が
 *     chooseMode → 徒歩は walkMinutes（距離ベース + walk_overrides 加算）、
 *     車は マトリクス分 × 時間帯係数（pickTimeModifier → carMinutes）。
 *   - 車マトリクス未登録は直線距離×係数の暫定値（provisionalCarMinutes）。
 *   - 車の係数は**出発時刻**で引く。到着側（P→A）は出発時刻が所要時間に依存して
 *     循環するため、小さな固定点反復（最大4回）で収束させる。
 *
 * 出力の各枠は depart_at / free_at / travel_in / travel_out / buffer の内訳を持ち、
 * フェーズ11 の reservations 控え（exclusion 制約の占有区間 depart_at〜free_at）に
 * そのまま写せる形にしてある。
 */

import { formatInTimeZone } from "date-fns-tz";
import { arrivalBuffers } from "./hotel";
import type { ArrivalBuffers, DestinationKind } from "./hotel";
import { APP_TIME_ZONE, remainingSlots } from "./shift";
import {
  carMinutes,
  chooseMode,
  pickTimeModifier,
  provisionalCarMinutes,
  walkMinutes,
} from "./travel";
import type { BufferSettings, TimeModifier, WalkSettings } from "./travel";

/** 受付リードタイムの既定（分 / spec 5-3 手順6） */
export const DEFAULT_LEAD_TIME_MIN = 90;
/** 枠の刻み幅の既定（分 / spec 5-3 手順7「15分刻みに切り上げ」） */
export const DEFAULT_SLOT_STEP_MIN = 15;
/** 車マトリクス未登録時の暫定値の既定係数（分/km / spec 5-1「直線距離×係数」） */
export const DEFAULT_PROVISIONAL_CAR_MIN_PER_KM = 4;

/**
 * 地点の参照。距離解決のキー（id）と、車マトリクス参照用のエリア id を持つ。
 * bases など「どのエリアか」を持たない地点は areaId: null（マトリクスを引けず、
 * 距離があれば暫定値で車時間を出す）。
 */
export interface PlaceRef {
  /** 地点の一意キー（base id / 住所 id / "area:xxx" 等。距離解決に使う） */
  id: string;
  /** 車マトリクス参照用のエリア id（不明地点は null） */
  areaId: string | null;
}

/**
 * 移動データの解決口。DB（PostGIS 距離・area_travel_times）またはテストの
 * 固定値を、呼び出し側が同期関数として注入する（engine は DB を知らない）。
 */
export interface TravelDataSource {
  /** 2地点間の直線距離（メートル）。不明なら null */
  distanceMeters(from: PlaceRef, to: PlaceRef): number | null;
  /** 車マトリクスの分数（時間帯係数適用前）。未登録なら null */
  carMatrixMinutes(fromAreaId: string, toAreaId: string): number | null;
  /** walk_overrides の加算分（橋・踏切等の分断区間 / spec 5-1）。無ければ 0 */
  walkAddedMinutes?(from: PlaceRef, to: PlaceRef): number;
}

/** セラピスト個人の移動設定（spec 5-1「セラピストごとの設定」） */
export interface TherapistTravelProfile {
  /** 車を使えるか。false は徒歩圏の予約のみ */
  canUseCar: boolean;
  /** 徒歩上限（therapists.walk_cap_meters ?? walk_settings.cap_meters を解決済みで渡す） */
  walkCapMeters: number;
}

/** shift（spec 5-3 手順1 の入力）。日跨ぎシフトは endAt が翌日（shiftInstants 参照） */
export interface EngineShift {
  startAt: Date;
  endAt: Date;
  /** 待機開始場所 B_start */
  baseStart: PlaceRef;
  /** 待機終了場所 B_end（gap_n の「帰れること」の終点） */
  baseEnd: PlaceRef;
  /** その日の対応エリア（shift_areas） */
  areaIds: readonly string[];
  /** 1日の最大施術本数（null = 上限なし） */
  maxBookings: number | null;
}

/** 既存予約（reservations の depart_at / free_at / 地点の写像） */
export interface ExistingReservation {
  /** 前の場所を出る時刻（占有区間の下端） */
  departAt: Date;
  /** 次へ動ける時刻（占有区間の上端。Ri のエリアにいる） */
  freeAt: Date;
  /** 予約先の地点（gap の P / N になる） */
  place: PlaceRef;
}

/** 占有区間（slot_holds 等）。手順8 の重複除外に使う */
export interface OccupiedRange {
  departAt: Date;
  freeAt: Date;
}

/** 目的地（派遣先）。ホテルなら extra_minutes を到着バッファに加算（spec 8-2） */
export interface EngineDestination {
  place: PlaceRef;
  kind: DestinationKind;
  /** 目的地がホテルのときの館内移動時間（分）。住居では無視 */
  hotelExtraMinutes?: number | null;
}

/** computeAvailableSlots の入力（すべて呼び出し側が用意。DB 非依存） */
export interface AvailabilityInput {
  therapist: TherapistTravelProfile;
  /** 施術時間 L = コース時間 + 選択オプション duration_min 合計（totalServiceMinutes） */
  serviceMinutes: number;
  destination: EngineDestination;
  /** その日の shift。無ければ null（→ 空を返す。is_day_off も null で渡す） */
  shift: EngineShift | null;
  /** 既存予約（held/confirmed）。順不同でよい（engine が depart_at 順に並べる） */
  reservations: readonly ExistingReservation[];
  /** 追加の占有区間（slot_holds 等）。省略時なし */
  holds?: readonly OccupiedRange[];
  /** 現在時刻 */
  now: Date;
  /** 受付リードタイム（分）。既定 90 */
  leadTimeMin?: number;
  walkSettings: WalkSettings;
  /** 車の時間帯係数（sort_order 順）。省略時は係数なし */
  timeModifiers?: readonly TimeModifier[];
  /** バッファ既定行（travel_buffers scope='default'） */
  bufferDefaults: BufferSettings;
  /** 目的地エリアの上書き行（scope='area'）。無ければ null */
  bufferOverride?: BufferSettings | null;
  travel: TravelDataSource;
  /** 既定 Asia/Tokyo。時間帯係数の "HH:MM" 判定に使う */
  timeZone?: string;
  /** 枠の刻み（分）。既定 15。60 の約数であること */
  slotStepMin?: number;
  /** 車マトリクス未登録時の暫定係数（分/km）。既定 4 */
  provisionalCarMinPerKm?: number;
}

/**
 * 予約可能な1枠。depart_at〜free_at が exclusion 制約の占有区間と整合する内訳
 * （フェーズ11 の reservations 控えにそのまま使える形）。
 */
export interface AvailableSlot {
  /** 案内する開始時刻 s（15分刻み）。施術は s + buffer_before から */
  startAt: Date;
  /** 施術終了 = s + buffer_before + L（reservations.end_at の控え） */
  serviceEndAt: Date;
  /** 前の場所を出る時刻 = s − buffer_arrive(駐車・ホテル込) − travel_in（reservations.depart_at） */
  departAt: Date;
  /** 次へ動ける時刻 = s + buffer_before + L + buffer_after（reservations.free_at） */
  freeAt: Date;
  /** P→A の移動（分・手段）。reservations.travel_in_min の控え */
  travelInMin: number;
  travelInMode: "walk" | "car";
  /** A→N の移動（分・手段）。reservations.travel_out_min の控え */
  travelOutMin: number;
  travelOutMode: "walk" | "car";
  /** バッファ内訳（arrive / parking(車のみ) / hotelExtra / before / after） */
  buffers: ArrivalBuffers;
  /** reservations.buffer_min の控え = arrivalTotal + before + after */
  bufferTotalMin: number;
  /** どの隙間か（0 = シフト開始〜最初の予約、最後 = gap_n） */
  gapIndex: number;
}

const MIN_MS = 60_000;

function addMin(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MIN_MS);
}

/**
 * 15分刻み（等）への切り上げ。epoch 基準の切り上げは、UTC オフセットが刻みの
 * 倍数のタイムゾーン（Asia/Tokyo = +9:00）で壁時計の :00/:15/:30/:45 に一致する。
 */
function ceilToStep(at: Date, stepMin: number): Date {
  const stepMs = stepMin * MIN_MS;
  return new Date(Math.ceil(at.getTime() / stepMs) * stepMs);
}

function assertIntMin(value: number, label: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${label} は ${min} 以上の整数であること: ${value}`);
  }
}

/** 距離・手段・基礎分数を解決した片道。車の分数だけが時刻（係数）で変わる */
interface ResolvedLeg {
  mode: "walk" | "car";
  /** walk の固定分数（override 加算済み）。car では 0 */
  walkFixedMin: number;
  /** car の係数適用前の基礎分数。walk では 0 */
  carBaseMin: number;
}

interface EngineContext {
  therapist: TherapistTravelProfile;
  walkSettings: WalkSettings;
  timeModifiers: readonly TimeModifier[];
  travel: TravelDataSource;
  timeZone: string;
  provisionalCarMinPerKm: number;
}

/**
 * P→A（または A→N）の手段と基礎分数を解決する。
 * 到達不能（徒歩上限超かつ車不可、または車でも移動時間を出せない）なら null。
 */
function resolveLeg(ctx: EngineContext, from: PlaceRef, to: PlaceRef): ResolvedLeg | null {
  if (from.id === to.id) return { mode: "walk", walkFixedMin: 0, carBaseMin: 0 };

  const distance = ctx.travel.distanceMeters(from, to);
  const matrix =
    from.areaId !== null && to.areaId !== null
      ? ctx.travel.carMatrixMinutes(from.areaId, to.areaId)
      : null;

  if (distance === null) {
    // 距離不明: chooseMode できない。車マトリクスがあれば車、無ければ到達不能
    if (!ctx.therapist.canUseCar || matrix === null) return null;
    return { mode: "car", walkFixedMin: 0, carBaseMin: matrix };
  }

  const mode = chooseMode(distance, {
    capMeters: ctx.therapist.walkCapMeters,
    canUseCar: ctx.therapist.canUseCar,
  });
  if (mode === "unreachable") return null;

  if (mode === "walk") {
    const added = ctx.travel.walkAddedMinutes?.(from, to) ?? 0;
    assertIntMin(added, "walkAddedMinutes", 0);
    return {
      mode: "walk",
      walkFixedMin: walkMinutes(distance, ctx.walkSettings) + added,
      carBaseMin: 0,
    };
  }

  const carBase =
    matrix ?? provisionalCarMinutes(distance, { minutesPerKm: ctx.provisionalCarMinPerKm });
  return { mode: "car", walkFixedMin: 0, carBaseMin: carBase };
}

/** 出発時刻 departAt の時間帯係数を適用した片道分数 */
function legMinutesAt(ctx: EngineContext, leg: ResolvedLeg, departAt: Date): number {
  if (leg.mode === "walk") return leg.walkFixedMin;
  const modifier = pickTimeModifier(
    ctx.timeModifiers,
    formatInTimeZone(departAt, ctx.timeZone, "HH:mm"),
  );
  return carMinutes(leg.carBaseMin, modifier);
}

/**
 * 到着側（P→A）の分数。出発時刻 = 到着時刻 − 所要時間 で、係数が所要時間に
 * 依存して循環するため、固定点反復（最大4回）で収束させる。
 * arriveBy = 建物到着時刻（s − buffer_arrive 合計）。
 */
function inboundMinutes(ctx: EngineContext, leg: ResolvedLeg, arriveBy: Date): number {
  if (leg.mode === "walk") return leg.walkFixedMin;
  let minutes = legMinutesAt(ctx, leg, arriveBy);
  for (let i = 0; i < 3; i += 1) {
    const next = legMinutesAt(ctx, leg, addMin(arriveBy, -minutes));
    if (next === minutes) break;
    minutes = next;
  }
  return minutes;
}

/** [departAt, freeAt) が占有区間のどれかと重なるか（手順8。区間は半開） */
function overlapsAny(
  departAt: Date,
  freeAt: Date,
  ranges: readonly OccupiedRange[],
): boolean {
  const d = departAt.getTime();
  const f = freeAt.getTime();
  return ranges.some((r) => d < r.freeAt.getTime() && r.departAt.getTime() < f);
}

/**
 * 空き枠の算出（spec 5-3 の本体）。予約可能な開始時刻を昇順で返す。
 * 各枠は exclusion 制約（depart_at〜free_at）と整合する内訳つき。
 */
export function computeAvailableSlots(input: AvailabilityInput): AvailableSlot[] {
  assertIntMin(input.serviceMinutes, "serviceMinutes", 1);
  const leadTimeMin = input.leadTimeMin ?? DEFAULT_LEAD_TIME_MIN;
  assertIntMin(leadTimeMin, "leadTimeMin", 0);
  const stepMin = input.slotStepMin ?? DEFAULT_SLOT_STEP_MIN;
  assertIntMin(stepMin, "slotStepMin", 1);
  if (stepMin > 60 || 60 % stepMin !== 0) {
    throw new RangeError(`slotStepMin は 60 の約数であること: ${stepMin}`);
  }
  if (input.destination.place.areaId === null) {
    throw new RangeError("destination.place.areaId は必須（対応エリア判定に使う）");
  }

  // 1. shift 無 → 空（is_day_off の日も呼び出し側が null で渡す）
  const shift = input.shift;
  if (shift === null) return [];
  if (shift.endAt.getTime() <= shift.startAt.getTime()) return [];

  // 2. A が対応エリアに含まれなければ空
  if (!shift.areaIds.includes(input.destination.place.areaId)) return [];

  // 3. 上限本数に達していれば空
  const remaining = remainingSlots(shift.maxBookings, input.reservations.length);
  if (remaining !== null && remaining <= 0) return [];

  const ctx: EngineContext = {
    therapist: input.therapist,
    walkSettings: input.walkSettings,
    timeModifiers: input.timeModifiers ?? [],
    travel: input.travel,
    timeZone: input.timeZone ?? APP_TIME_ZONE,
    provisionalCarMinPerKm: input.provisionalCarMinPerKm ?? DEFAULT_PROVISIONAL_CAR_MIN_PER_KM,
  };

  // 4. 既存予約を depart_at 順に
  const reservations = [...input.reservations].sort(
    (a, b) => a.departAt.getTime() - b.departAt.getTime(),
  );

  // 5. 隙間列挙（gap0 / gap_i / gap_n）
  interface Gap {
    tP: Date;
    p: PlaceRef;
    tN: Date;
    n: PlaceRef;
  }
  const gaps: Gap[] = [];
  let cursorAt = shift.startAt;
  let cursorPlace = shift.baseStart;
  for (const r of reservations) {
    gaps.push({ tP: cursorAt, p: cursorPlace, tN: r.departAt, n: r.place });
    cursorAt = r.freeAt;
    cursorPlace = r.place;
  }
  // gap_n: N = B_end（「帰れること」まで条件に入れる）
  gaps.push({ tP: cursorAt, p: cursorPlace, tN: shift.endAt, n: shift.baseEnd });

  const holds = input.holds ?? [];
  const leadFloor = addMin(input.now, leadTimeMin);
  const slots: AvailableSlot[] = [];

  gaps.forEach((gap, gapIndex) => {
    if (gap.tN.getTime() <= gap.tP.getTime()) return;

    const inbound = resolveLeg(ctx, gap.p, input.destination.place);
    if (inbound === null) return; // 到達不能（徒歩上限超×車不可 等）
    const outbound = resolveLeg(ctx, input.destination.place, gap.n);
    if (outbound === null) return; // 次へ（または B_end へ）動けない

    // バッファ: 駐車は車のみ、ホテルなら extra_minutes を到着側に加算（spec 5-2・8-2）
    const buffers = arrivalBuffers({
      mode: inbound.mode,
      defaults: input.bufferDefaults,
      override: input.bufferOverride ?? null,
      destination: {
        kind: input.destination.kind,
        hotelExtraMinutes: input.destination.hotelExtraMinutes,
      },
    });
    const occupyMin = buffers.beforeMin + input.serviceMinutes + buffers.afterMin;

    // 7. 15分刻みに切り上げて列挙。
    //    下限: max(t_p, now + リードタイム)（travel ≥ 0 なので安全な下界。
    //          個々の s は下で depart_at ≥ t_p を厳密に判定する）
    //    上限: t_n − (before + L + after)（travel(A→N) ≥ 0 の上界。
    //          深夜係数で遅い時間ほど移動が縮むため、途中の不成立で打ち切らず全列挙する）
    const enumFrom = ceilToStep(
      new Date(Math.max(gap.tP.getTime(), leadFloor.getTime())),
      stepMin,
    );
    const enumTo = addMin(gap.tN, -occupyMin);

    for (let s = enumFrom; s.getTime() <= enumTo.getTime(); s = addMin(s, stepMin)) {
      // 6-1. s ≥ t_p + travel(P→A) + buffer_arrive（depart_at ≥ t_p と等価）
      const arriveBy = addMin(s, -buffers.arrivalTotalMin);
      const travelInMin = inboundMinutes(ctx, inbound, arriveBy);
      const departAt = addMin(arriveBy, -travelInMin);
      if (departAt.getTime() < gap.tP.getTime()) continue;

      // 6-3. s + buffer_before + L + buffer_after + travel(A→N) ≤ t_n
      const freeAt = addMin(s, occupyMin);
      const travelOutMin = legMinutesAt(ctx, outbound, freeAt);
      if (addMin(freeAt, travelOutMin).getTime() > gap.tN.getTime()) continue;

      // 8. held / confirmed（slot_holds 等）の占有区間との重複を除外
      if (overlapsAny(departAt, freeAt, holds)) continue;

      slots.push({
        startAt: s,
        serviceEndAt: addMin(s, buffers.beforeMin + input.serviceMinutes),
        departAt,
        freeAt,
        travelInMin,
        travelInMode: inbound.mode,
        travelOutMin,
        travelOutMode: outbound.mode,
        buffers,
        bufferTotalMin: buffers.arrivalTotalMin + buffers.beforeMin + buffers.afterMin,
        gapIndex,
      });
    }
  });

  return slots;
}

/**
 * 最短で案内できる枠（spec 5-4）。computeAvailableSlots を now 起点で回して
 * 最初の1件を返す。無ければ null。
 * エリア未指定のときの「代表エリア概算（〇〇区の場合）」は呼び出し側が
 * destination に代表エリアを渡し、表示側で条件を明記する。
 */
export function earliestAvailable(input: AvailabilityInput): AvailableSlot | null {
  const slots = computeAvailableSlots(input);
  return slots[0] ?? null;
}

/**
 * 枠の開始時刻の表示用ラベル（"HH:mm"）。公開側 EarliestSlot の time に差し込む。
 * 文言（「最短 {time} から案内可能」等）は CMS 側テンプレートが持つ。
 */
export function slotTimeLabel(slot: AvailableSlot, timeZone: string = APP_TIME_ZONE): string {
  return formatInTimeZone(slot.startAt, timeZone, "HH:mm");
}
