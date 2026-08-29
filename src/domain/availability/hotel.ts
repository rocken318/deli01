/**
 * ホテル館内移動時間の純粋関数（フェーズ7 / spec 8-2・5-2）。
 *
 * DB にも Next.js にも依存しない。hotels テーブルの値（extra_minutes / is_blocked）は
 * 呼び出し側（フェーズ9 の空き枠エンジン・フェーズ11/12 の予約作成）が数値で渡す。
 *
 * spec 8-2 ★:
 * - **extra_minutes を移動バッファに加算する。** 大型ホテルはエントランスから
 *   部屋まで10分かかる。目的地がホテルのときだけ、到着前バッファ
 *   （travel_buffers.arrive_min + 車なら parking_min）に館内移動分を積む。
 * - **is_blocked のホテルは予約を作らせない。** 公開側でも選べない。
 *   判定ヘルパ isHotelBookable を予約作成（フェーズ11/12）と公開側の選択肢
 *   フィルタの両方が使う。
 */

import { travelBuffers } from "./travel";
import type { AppliedBuffers, BufferSettings, TravelMode } from "./travel";

/** 目的地の種別。住居（自宅等）かホテルか */
export type DestinationKind = "residence" | "hotel";

/** hotels テーブルのうち、空き枠・予約判定に必要な列の写像 */
export interface HotelForBooking {
  /** 到着から部屋までの追加時間（分・整数 / spec 8-2） */
  extraMinutes: number;
  /** 入館お断りの施設（spec 8-2: 予約を作らせない） */
  isBlocked: boolean;
}

/** 到着バッファ + ホテル館内移動の合成結果 */
export interface ArrivalBuffers extends AppliedBuffers {
  /** ホテル館内移動分（目的地が住居なら 0） */
  hotelExtraMin: number;
  /**
   * 到着系バッファの合計 = arriveMin + parkingMin + hotelExtraMin。
   * spec 5-3 の条件 `s ≥ t_p + travel(P→A) + buffer_arrive` の buffer_arrive に相当。
   */
  arrivalTotalMin: number;
}

function assertExtraMinutes(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`extra_minutes は 0 以上の整数（分）であること: ${value}`);
  }
}

/**
 * 目的地種別に応じたホテル館内移動時間（分・整数）。
 * - 目的地がホテル → hotel.extra_minutes（null/undefined = 仮登録で未補完 → 0）
 * - 目的地が住居   → 常に 0（ホテル情報が渡されていても加算しない）
 *
 * 仮登録ホテル（spec 8-2「電話を止めない」）は extra_minutes 未入力のことがあるため、
 * null は 0 として扱う（エラーにしない）。負数・小数はデータ不正なので RangeError。
 */
export function arrivalExtraMinutes(input: {
  destinationKind: DestinationKind;
  hotelExtraMinutes?: number | null;
}): number {
  const extra = input.hotelExtraMinutes ?? 0;
  assertExtraMinutes(extra);
  return input.destinationKind === "hotel" ? extra : 0;
}

/**
 * 到着前バッファ + ホテル館内移動の合成（★フェーズ7 完了条件「ホテルの館内移動時間が加算される」）。
 * 既存の travelBuffers（spec 5-2: 駐車は車のみ）を適用した上で、目的地がホテルの
 * ときだけ extra_minutes を積む。フェーズ9 の空き枠エンジンは arrivalTotalMin を
 * `s ≥ t_p + travel(P→A) + buffer_arrive` の buffer_arrive として使う。
 */
export function arrivalBuffers(input: {
  mode: Exclude<TravelMode, "unreachable">;
  defaults: BufferSettings;
  override?: BufferSettings | null;
  destination: { kind: DestinationKind; hotelExtraMinutes?: number | null };
}): ArrivalBuffers {
  const applied = travelBuffers({
    mode: input.mode,
    defaults: input.defaults,
    override: input.override,
  });
  const hotelExtraMin = arrivalExtraMinutes({
    destinationKind: input.destination.kind,
    hotelExtraMinutes: input.destination.hotelExtraMinutes,
  });
  return {
    ...applied,
    hotelExtraMin,
    arrivalTotalMin: applied.arriveMin + applied.parkingMin + hotelExtraMin,
  };
}

/**
 * ホテルが予約対象か（spec 8-2: is_blocked のホテルは予約を作らせない）。
 * 公開側の選択肢フィルタと、予約作成（フェーズ11/12）のガードの両方で使う。
 */
export function isHotelBookable(hotel: Pick<HotelForBooking, "isBlocked">): boolean {
  return !hotel.isBlocked;
}
