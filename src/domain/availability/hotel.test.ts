import { describe, expect, it } from "vitest";
import {
  arrivalBuffers,
  arrivalExtraMinutes,
  isHotelBookable,
} from "./hotel";
import type { BufferSettings } from "./travel";

/**
 * フェーズ7の完了条件（spec 14章 #7）「ホテルの館内移動時間が加算される」を
 * 純粋関数レベルで固定する（spec 8-2・5-2）。
 * - 同一距離・同一バッファでも destination=hotel(extra_minutes>0) のとき
 *   総到着時間が extra_minutes 分だけ増える
 * - 住居（extra=0 扱い）では増えない
 * - is_blocked のホテルは予約対象外（isHotelBookable）
 * 空き枠アルゴリズム全体への組み込みテストはフェーズ9で行う。
 */

/** spec 5-2 の既定値（シードと同じ値） */
const defaults: BufferSettings = { arriveMin: 10, parkingMin: 15, beforeMin: 5, afterMin: 10 };

describe("arrivalExtraMinutes（目的地がホテルのときだけ extra_minutes / spec 8-2）", () => {
  it("hotel + extra_minutes=12 → 12分", () => {
    expect(arrivalExtraMinutes({ destinationKind: "hotel", hotelExtraMinutes: 12 })).toBe(12);
  });

  it("residence（住居）は extra_minutes が渡されていても 0", () => {
    expect(arrivalExtraMinutes({ destinationKind: "residence", hotelExtraMinutes: 12 })).toBe(0);
    expect(arrivalExtraMinutes({ destinationKind: "residence" })).toBe(0);
  });

  it("仮登録ホテル（extra 未補完 = null/undefined）は 0 として扱う（電話を止めない / spec 8-2）", () => {
    expect(arrivalExtraMinutes({ destinationKind: "hotel", hotelExtraMinutes: null })).toBe(0);
    expect(arrivalExtraMinutes({ destinationKind: "hotel" })).toBe(0);
  });

  it("負数・小数は RangeError（分は 0 以上の整数）", () => {
    expect(() => arrivalExtraMinutes({ destinationKind: "hotel", hotelExtraMinutes: -1 })).toThrow(
      RangeError,
    );
    expect(() => arrivalExtraMinutes({ destinationKind: "hotel", hotelExtraMinutes: 7.5 })).toThrow(
      RangeError,
    );
  });
});

describe("arrivalBuffers: 到着前バッファ + ホテル館内移動の合成 ★完了条件", () => {
  it("同一条件で destination=hotel(extra=10) は住居より arrivalTotalMin が 10分増える", () => {
    const residence = arrivalBuffers({
      mode: "car",
      defaults,
      destination: { kind: "residence" },
    });
    const hotel = arrivalBuffers({
      mode: "car",
      defaults,
      destination: { kind: "hotel", hotelExtraMinutes: 10 },
    });
    expect(residence.arrivalTotalMin).toBe(10 + 15); // arrive + parking
    expect(hotel.arrivalTotalMin).toBe(10 + 15 + 10);
    expect(hotel.arrivalTotalMin - residence.arrivalTotalMin).toBe(10);
    expect(hotel.hotelExtraMin).toBe(10);
    expect(residence.hotelExtraMin).toBe(0);
  });

  it("extra=0 のホテルは住居と同じ総到着時間", () => {
    const residence = arrivalBuffers({ mode: "car", defaults, destination: { kind: "residence" } });
    const hotel = arrivalBuffers({
      mode: "car",
      defaults,
      destination: { kind: "hotel", hotelExtraMinutes: 0 },
    });
    expect(hotel.arrivalTotalMin).toBe(residence.arrivalTotalMin);
  });

  it("徒歩では駐車バッファ 0（spec 5-2）のまま館内移動だけ積まれる", () => {
    const walkHotel = arrivalBuffers({
      mode: "walk",
      defaults,
      destination: { kind: "hotel", hotelExtraMinutes: 12 },
    });
    expect(walkHotel.parkingMin).toBe(0);
    expect(walkHotel.arrivalTotalMin).toBe(10 + 0 + 12);
  });

  it("エリア別上書き（港区: 駐車20分）と館内移動が両方効く", () => {
    const override: BufferSettings = { arriveMin: 10, parkingMin: 20, beforeMin: 5, afterMin: 10 };
    const r = arrivalBuffers({
      mode: "car",
      defaults,
      override,
      destination: { kind: "hotel", hotelExtraMinutes: 10 },
    });
    expect(r.arrivalTotalMin).toBe(10 + 20 + 10);
  });

  it("施術前後バッファ（beforeMin/afterMin）は変えない（到着系のみの合成）", () => {
    const r = arrivalBuffers({
      mode: "car",
      defaults,
      destination: { kind: "hotel", hotelExtraMinutes: 10 },
    });
    expect(r.beforeMin).toBe(5);
    expect(r.afterMin).toBe(10);
  });

  it("結果は常に整数（分）", () => {
    const r = arrivalBuffers({
      mode: "car",
      defaults,
      destination: { kind: "hotel", hotelExtraMinutes: 3 },
    });
    expect(Number.isInteger(r.arrivalTotalMin)).toBe(true);
    expect(Number.isInteger(r.hotelExtraMin)).toBe(true);
  });
});

describe("isHotelBookable（spec 8-2: is_blocked のホテルは予約を作らせない）", () => {
  it("is_blocked=false → 予約可", () => {
    expect(isHotelBookable({ isBlocked: false })).toBe(true);
  });

  it("is_blocked=true → 予約対象外（公開側でも選べない）", () => {
    expect(isHotelBookable({ isBlocked: true })).toBe(false);
  });
});
