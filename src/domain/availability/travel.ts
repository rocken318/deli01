/**
 * 移動手段・移動時間・バッファの純粋関数（フェーズ6 / spec 5-1・5-2）。
 *
 * DB にも Next.js にも依存しない（spec 5章の要件）。
 * PostGIS で求めた直線距離（メートル）や DB のマトリクス値は、呼び出し側
 * （src/lib/availability/geo.ts、フェーズ9の空き枠エンジン）がここへ数値で渡す。
 *
 * 徒歩と車を同じ仕組みで扱わない（spec 5-1）:
 * - 徒歩: 距離から毎回計算。徒歩時間(分) = 直線距離(m) × 迂回係数 ÷ 分速。
 *   上限（cap_meters）超で車に切替。分断区間の補正は walk_overrides の added_minutes。
 * - 車: エリア間マトリクスの分数に時間帯係数（multiplier・additional）を適用。
 *   未登録エリア間は直線距離×係数の暫定値（provisionalCarMinutes）。
 *
 * 時間は「分の整数」。移動を短く見積もると遅刻に直結するため、端数は常に切り上げる。
 * 時刻は Asia/Tokyo のローカル時刻 "HH:MM"（呼び出し側が date-fns-tz で変換して渡す）。
 */

/** walk_settings テーブルの写像（単一行 / CMS で調整可） */
export interface WalkSettings {
  /** 迂回係数（既定 1.30） */
  detourFactor: number;
  /** 分速 m/分（既定 80。道具を持って歩くので遅め） */
  speedMPerMin: number;
  /** 徒歩上限メートル（既定 1600 ≒ 約25分）。超えたら車に切替 */
  capMeters: number;
}

/** 移動手段の判定結果 */
export type TravelMode = "walk" | "car" | "unreachable";

/** travel_time_modifiers テーブルの写像（車の時間帯係数） */
export interface TimeModifier {
  /** 適用開始（"HH:MM"、含む）。timeFrom > timeTo なら日跨ぎ区間（例 23:00〜05:00） */
  timeFrom: string;
  /** 適用終了（"HH:MM"、含まない） */
  timeTo: string;
  /** 乗数。深夜 < 1（0.75〜）、朝夕 1.3〜1.5 */
  multiplier: number;
  /** 分の加算（乗算後に足す） */
  additional: number;
}

/** travel_buffers テーブル1行分の写像（spec 5-2） */
export interface BufferSettings {
  arriveMin: number;
  parkingMin: number;
  beforeMin: number;
  afterMin: number;
}

/** travelBuffers の結果。駐車は車のみ（徒歩では 0）。 */
export interface AppliedBuffers {
  arriveMin: number;
  parkingMin: number;
  beforeMin: number;
  afterMin: number;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} は 0 以上の有限数であること: ${value}`);
  }
}

/**
 * 徒歩時間（分・切り上げ）。
 * 徒歩時間(分) = 直線距離(m) × 迂回係数 ÷ 分速（spec 5-1）。
 * 切り上げの理由: 分未満を切り捨てると移動を短く見積もり遅刻側に倒れるため。
 */
export function walkMinutes(
  distanceMeters: number,
  settings: Pick<WalkSettings, "detourFactor" | "speedMPerMin">,
): number {
  assertFiniteNonNegative(distanceMeters, "distanceMeters");
  if (!Number.isFinite(settings.detourFactor) || settings.detourFactor < 1) {
    throw new RangeError(`detourFactor は 1 以上であること: ${settings.detourFactor}`);
  }
  if (!Number.isFinite(settings.speedMPerMin) || settings.speedMPerMin <= 0) {
    throw new RangeError(`speedMPerMin は正の数であること: ${settings.speedMPerMin}`);
  }
  return Math.ceil((distanceMeters * settings.detourFactor) / settings.speedMPerMin);
}

/** 徒歩上限内か（境界値 capMeters ちょうどは「徒歩圏」に含める） */
export function isWithinWalkCap(distanceMeters: number, capMeters: number): boolean {
  assertFiniteNonNegative(distanceMeters, "distanceMeters");
  assertFiniteNonNegative(capMeters, "capMeters");
  return distanceMeters <= capMeters;
}

/**
 * 移動手段の判定（spec 5-1・フェーズ6の完了条件「徒歩と車が閾値で切り替わる」）。
 * - 上限以内 → walk
 * - 上限超 かつ 車可 → car
 * - 上限超 かつ 車不可（免許・車両なし）→ unreachable（徒歩圏の予約しか受けない）
 */
export function chooseMode(
  distanceMeters: number,
  opts: { capMeters: number; canUseCar: boolean },
): TravelMode {
  if (isWithinWalkCap(distanceMeters, opts.capMeters)) return "walk";
  return opts.canUseCar ? "car" : "unreachable";
}

/**
 * 車の移動時間（分・切り上げ）。マトリクスの分数に時間帯係数を適用する。
 * 深夜（multiplier < 1）は昼より短くなる（spec 5-1「深夜は速くなる」）。
 * modifier が null（該当時間帯なし）なら素の分数を返す。
 */
export function carMinutes(
  baseMinutes: number,
  modifier: Pick<TimeModifier, "multiplier" | "additional"> | null,
): number {
  assertFiniteNonNegative(baseMinutes, "baseMinutes");
  if (modifier === null) return Math.ceil(baseMinutes);
  if (!Number.isFinite(modifier.multiplier) || modifier.multiplier <= 0) {
    throw new RangeError(`multiplier は正の数であること: ${modifier.multiplier}`);
  }
  if (!Number.isInteger(modifier.additional)) {
    throw new RangeError(`additional は整数（分）であること: ${modifier.additional}`);
  }
  const applied = Math.ceil(baseMinutes * modifier.multiplier) + modifier.additional;
  return Math.max(0, applied);
}

/** "HH:MM"（Asia/Tokyo ローカル）→ 0〜1439 の分に変換 */
function toMinutesOfDay(hhmm: string): number {
  const m = /^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new RangeError(`時刻は "HH:MM"（00:00〜23:59）であること: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 時刻に該当する時間帯係数を選ぶ。区間は [timeFrom, timeTo)（開始を含み終了を含まない）。
 * timeFrom > timeTo の行は日跨ぎ（例 23:00〜05:00 = 23:00以降 または 05:00未満）。
 * 複数該当時は先頭（呼び出し側で sort_order 順に渡す）。該当なしは null（係数なし = 素の分数）。
 */
export function pickTimeModifier<T extends Pick<TimeModifier, "timeFrom" | "timeTo">>(
  modifiers: readonly T[],
  atTime: string,
): T | null {
  const at = toMinutesOfDay(atTime);
  for (const mod of modifiers) {
    const from = toMinutesOfDay(mod.timeFrom);
    const to = toMinutesOfDay(mod.timeTo);
    const hit =
      from <= to
        ? at >= from && at < to // 通常区間
        : at >= from || at < to; // 日跨ぎ区間
    if (hit) return mod;
  }
  return null;
}

/**
 * 未登録エリア間の車移動の暫定値（分・切り上げ / spec 5-1「直線距離×係数」）。
 * minutesPerKm は「1km あたり何分か」（管理画面で調整可能にする想定。都内なら 3〜4）。
 * 管理画面には「要設定」として一覧表示する（マトリクス整備を促す）。
 */
export function provisionalCarMinutes(
  distanceMeters: number,
  opts: { minutesPerKm: number },
): number {
  assertFiniteNonNegative(distanceMeters, "distanceMeters");
  if (!Number.isFinite(opts.minutesPerKm) || opts.minutesPerKm <= 0) {
    throw new RangeError(`minutesPerKm は正の数であること: ${opts.minutesPerKm}`);
  }
  return Math.ceil((distanceMeters / 1000) * opts.minutesPerKm);
}

/**
 * 移動バッファの適用（spec 5-2）。
 * - override（エリア別上書き行）があればそれを、なければ defaults（既定行）を使う
 * - **駐車（parkingMin）は車のときだけ加算**。徒歩では 0（spec 5-2 の表）
 */
export function travelBuffers(input: {
  mode: Exclude<TravelMode, "unreachable">;
  defaults: BufferSettings;
  override?: BufferSettings | null;
}): AppliedBuffers {
  const src = input.override ?? input.defaults;
  for (const [label, v] of Object.entries(src)) {
    assertFiniteNonNegative(v, label);
    if (!Number.isInteger(v)) throw new RangeError(`${label} は整数（分）であること: ${v}`);
  }
  return {
    arriveMin: src.arriveMin,
    parkingMin: input.mode === "car" ? src.parkingMin : 0,
    beforeMin: src.beforeMin,
    afterMin: src.afterMin,
  };
}
