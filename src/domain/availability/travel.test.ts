import { describe, expect, it } from "vitest";
import {
  carMinutes,
  chooseMode,
  isWithinWalkCap,
  pickTimeModifier,
  provisionalCarMinutes,
  travelBuffers,
  walkMinutes,
  type BufferSettings,
  type TimeModifier,
} from "./travel";

/**
 * フェーズ6の完了条件（spec 14章 #6）「徒歩と車が閾値で切り替わる」と、
 * spec 5-3 のテスト必須項目のうち移動系（徒歩上限前後の切替 / 深夜係数 /
 * 駐車バッファは車のみ）を純粋関数レベルで固定する。
 * 空き枠アルゴリズム全体への組み込みテストはフェーズ9で行う。
 */

/** spec 5-1 の既定値（シードと同じ値。テスト内の期待値計算に使う） */
const walk = { detourFactor: 1.3, speedMPerMin: 80 };
const CAP = 1600;

describe("walkMinutes（徒歩時間 = 距離 × 迂回係数 ÷ 分速）", () => {
  it("1600m × 1.30 ÷ 80 = 26分（上限ちょうど ≒ 約25分の仕様感）", () => {
    expect(walkMinutes(1600, walk)).toBe(26);
  });

  it("端数は切り上げる（1000m → 16.25分 → 17分）。短く見積もると遅刻側に倒れるため", () => {
    expect(walkMinutes(1000, walk)).toBe(17);
  });

  it("距離 0 は 0分", () => {
    expect(walkMinutes(0, walk)).toBe(0);
  });

  it("結果は常に整数（分）", () => {
    for (const d of [1, 123, 799, 1599, 1601]) {
      expect(Number.isInteger(walkMinutes(d, walk))).toBe(true);
    }
  });

  it("不正入力（負の距離・分速0・係数<1）は RangeError", () => {
    expect(() => walkMinutes(-1, walk)).toThrow(RangeError);
    expect(() => walkMinutes(100, { detourFactor: 1.3, speedMPerMin: 0 })).toThrow(RangeError);
    expect(() => walkMinutes(100, { detourFactor: 0.9, speedMPerMin: 80 })).toThrow(RangeError);
  });
});

describe("chooseMode: 徒歩上限（1.6km）の前後で徒歩と車が切り替わる ★完了条件", () => {
  it("1599m → walk（上限未満）", () => {
    expect(chooseMode(1599, { capMeters: CAP, canUseCar: true })).toBe("walk");
  });

  it("1600m → walk（上限ちょうどは徒歩圏に含める）", () => {
    expect(chooseMode(1600, { capMeters: CAP, canUseCar: true })).toBe("walk");
  });

  it("1601m → car（上限超で車に切替 / spec 5-1）", () => {
    expect(chooseMode(1601, { capMeters: CAP, canUseCar: true })).toBe("car");
  });

  it("車を使えない人は上限超で unreachable（徒歩圏の予約しか受けない / spec 5-1）", () => {
    expect(chooseMode(1601, { capMeters: CAP, canUseCar: false })).toBe("unreachable");
    // 上限内なら車不可でも徒歩で行ける
    expect(chooseMode(1600, { capMeters: CAP, canUseCar: false })).toBe("walk");
  });

  it("徒歩上限の個人差（セラピスト別 cap）でも同じ閾値判定が効く", () => {
    // 短くしたい人: cap 800m
    expect(chooseMode(801, { capMeters: 800, canUseCar: true })).toBe("car");
    expect(chooseMode(800, { capMeters: 800, canUseCar: true })).toBe("walk");
  });

  it("isWithinWalkCap の境界（<= cap が徒歩圏）", () => {
    expect(isWithinWalkCap(1599, CAP)).toBe(true);
    expect(isWithinWalkCap(1600, CAP)).toBe(true);
    expect(isWithinWalkCap(1601, CAP)).toBe(false);
  });
});

describe("carMinutes（マトリクス分数 × 時間帯係数）", () => {
  it("深夜係数 0.75 で車が短くなる（20分 → 15分 / spec 5-1「深夜は速くなる」）", () => {
    expect(carMinutes(20, { multiplier: 0.75, additional: 0 })).toBe(15);
  });

  it("朝夕係数 1.5 で長くなる（20分 → 30分）", () => {
    expect(carMinutes(20, { multiplier: 1.5, additional: 0 })).toBe(30);
  });

  it("係数なし（該当時間帯なし）は素の分数", () => {
    expect(carMinutes(20, null)).toBe(20);
  });

  it("additional が乗算後に加算される（20 × 1.3 = 26 → +5 = 31）", () => {
    expect(carMinutes(20, { multiplier: 1.3, additional: 5 })).toBe(31);
  });

  it("端数は切り上げ（10 × 0.75 = 7.5 → 8分）", () => {
    expect(carMinutes(10, { multiplier: 0.75, additional: 0 })).toBe(8);
  });

  it("結果が負になる組み合わせでも 0 で下限クランプ", () => {
    expect(carMinutes(5, { multiplier: 0.75, additional: -10 })).toBe(0);
  });

  it("不正入力（負の分数・係数0）は RangeError", () => {
    expect(() => carMinutes(-1, null)).toThrow(RangeError);
    expect(() => carMinutes(10, { multiplier: 0, additional: 0 })).toThrow(RangeError);
  });
});

describe("pickTimeModifier（時間帯係数の選択 / Asia/Tokyo ローカル HH:MM）", () => {
  const modifiers: TimeModifier[] = [
    { timeFrom: "23:00", timeTo: "05:00", multiplier: 0.75, additional: 0 }, // 深夜（日跨ぎ）
    { timeFrom: "07:00", timeTo: "09:30", multiplier: 1.4, additional: 0 }, // 朝
    { timeFrom: "17:00", timeTo: "19:30", multiplier: 1.3, additional: 0 }, // 夕
  ];

  it("深夜（日跨ぎ 23:00〜05:00）: 01:00 と 23:00 に該当、05:00 と 12:00 は非該当", () => {
    expect(pickTimeModifier(modifiers, "01:00")?.multiplier).toBe(0.75);
    expect(pickTimeModifier(modifiers, "23:00")?.multiplier).toBe(0.75);
    expect(pickTimeModifier(modifiers, "05:00")).toBeNull(); // 終了は含まない
    expect(pickTimeModifier(modifiers, "12:00")).toBeNull();
  });

  it("朝の通常区間: 開始 07:00 は含み、終了 09:30 は含まない", () => {
    expect(pickTimeModifier(modifiers, "07:00")?.multiplier).toBe(1.4);
    expect(pickTimeModifier(modifiers, "09:29")?.multiplier).toBe(1.4);
    expect(pickTimeModifier(modifiers, "09:30")).toBeNull();
  });

  it('"HH:MM:SS"（postgres の time 素の値）も受理する（秒は切り捨て）', () => {
    // postgres の time 列は select で "23:00:00" 形式を返すため、フェーズ9で
    // 素の値を渡しても RangeError にならないこと（reviewer 推奨1）。
    expect(pickTimeModifier(modifiers, "23:00:00")?.multiplier).toBe(0.75);
    expect(pickTimeModifier(modifiers, "07:00:30")?.multiplier).toBe(1.4);
    expect(pickTimeModifier(modifiers, "09:30:00")).toBeNull();
  });

  it("深夜係数を通すと同じ経路の車移動が昼より短くなる（spec 5-3 該当分）", () => {
    const base = 40; // マトリクス上のエリア間分数
    const day = carMinutes(base, pickTimeModifier(modifiers, "13:00"));
    const night = carMinutes(base, pickTimeModifier(modifiers, "01:30"));
    const rush = carMinutes(base, pickTimeModifier(modifiers, "08:00"));
    expect(night).toBe(30); // 40 × 0.75
    expect(day).toBe(40);
    expect(rush).toBe(56); // 40 × 1.4
    expect(night).toBeLessThan(day);
    expect(day).toBeLessThan(rush);
  });

  it("不正な時刻表記は RangeError", () => {
    expect(() => pickTimeModifier(modifiers, "24:00")).toThrow(RangeError);
    expect(() => pickTimeModifier(modifiers, "7:00")).toThrow(RangeError);
  });
});

describe("provisionalCarMinutes（未登録エリア間の暫定値 = 直線距離 × 係数）", () => {
  it("10km × 3分/km = 30分", () => {
    expect(provisionalCarMinutes(10_000, { minutesPerKm: 3 })).toBe(30);
  });

  it("端数は切り上げ（2.5km × 3 = 7.5 → 8分）", () => {
    expect(provisionalCarMinutes(2_500, { minutesPerKm: 3 })).toBe(8);
  });
});

describe("travelBuffers（spec 5-2: 駐車バッファは車のみ）", () => {
  const defaults: BufferSettings = { arriveMin: 10, parkingMin: 15, beforeMin: 5, afterMin: 10 };

  it("車: 到着前10 + 駐車15 + 施術前5 + 施術後10", () => {
    expect(travelBuffers({ mode: "car", defaults })).toEqual({
      arriveMin: 10,
      parkingMin: 15,
      beforeMin: 5,
      afterMin: 10,
    });
  });

  it("徒歩: 駐車バッファが 0 になる（車のときだけ加算 ★spec 5-3 該当分）", () => {
    expect(travelBuffers({ mode: "walk", defaults })).toEqual({
      arriveMin: 10,
      parkingMin: 0,
      beforeMin: 5,
      afterMin: 10,
    });
  });

  it("エリア別上書き（都心の駐車20分）が既定より優先される", () => {
    const override: BufferSettings = { arriveMin: 10, parkingMin: 20, beforeMin: 5, afterMin: 10 };
    expect(travelBuffers({ mode: "car", defaults, override }).parkingMin).toBe(20);
    // 上書きがあっても徒歩なら駐車は 0
    expect(travelBuffers({ mode: "walk", defaults, override }).parkingMin).toBe(0);
  });

  it("override が null なら既定を使う", () => {
    expect(travelBuffers({ mode: "car", defaults, override: null }).parkingMin).toBe(15);
  });

  it("分が整数でない・負のバッファは RangeError", () => {
    expect(() =>
      travelBuffers({ mode: "car", defaults: { ...defaults, parkingMin: 1.5 } }),
    ).toThrow(RangeError);
    expect(() =>
      travelBuffers({ mode: "car", defaults: { ...defaults, arriveMin: -1 } }),
    ).toThrow(RangeError);
  });
});
