import { describe, expect, it } from "vitest";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  computeAvailableSlots,
  earliestAvailable,
  slotTimeLabel,
} from "./engine";
import type {
  AvailabilityInput,
  AvailableSlot,
  EngineShift,
  PlaceRef,
  TravelDataSource,
} from "./engine";
import type { BufferSettings, TimeModifier, WalkSettings } from "./travel";
import { totalServiceMinutes } from "../catalog/pricing";

/**
 * spec 5-3「このアルゴリズムに対するテストを最優先で書く」の全ケース（フェーズ9
 * 完了条件 / spec 14章 #9・15章）+ ホテル加算・オプション L・ホールド重複除外。
 *
 * 期待値はすべて手計算:
 *   徒歩分 = ceil(距離m × 1.3 ÷ 80)、車分 = ceil(マトリクス分 × 係数)
 *   バッファ既定 = 到着前10 / 駐車15(車のみ) / 施術前5 / 施術後10（spec 5-2）
 *   占有 = before(5) + L + after(10)。L=60 なら 75分
 */

const TZ = "Asia/Tokyo";
const DAY = "2026-09-01";
const NEXT_DAY = "2026-09-02";

const jst = (date: string, time: string): Date => fromZonedTime(`${date}T${time}:00`, TZ);
const startTimes = (slots: readonly AvailableSlot[]): string[] =>
  slots.map((s) => formatInTimeZone(s.startAt, TZ, "HH:mm"));
const startStamps = (slots: readonly AvailableSlot[]): string[] =>
  slots.map((s) => formatInTimeZone(s.startAt, TZ, "MM-dd HH:mm"));

/** シードと同じ既定値（spec 5-1・5-2） */
const WALK: WalkSettings = { detourFactor: 1.3, speedMPerMin: 80, capMeters: 1600 };
const BUFFERS: BufferSettings = { arriveMin: 10, parkingMin: 15, beforeMin: 5, afterMin: 10 };
/** シードと同じ深夜係数（23:00〜05:00 ×0.75 / spec 5-1「深夜は速くなる」） */
const NIGHT_MODS: TimeModifier[] = [
  { timeFrom: "23:00", timeTo: "05:00", multiplier: 0.75, additional: 0 },
];

// 地点（テスト用の固定フィクスチャ）
const office: PlaceRef = { id: "base-office", areaId: "shibuya" };
const home: PlaceRef = { id: "dest-home", areaId: "shibuya" };
const res1: PlaceRef = { id: "res-1", areaId: "shibuya" };
const res2: PlaceRef = { id: "res-2", areaId: "shibuya" };

/** 距離・マトリクスを固定値で返す TravelDataSource（キーは "a|b"。双方向） */
function src(opts: {
  distances?: Record<string, number>;
  matrix?: Record<string, number>;
  walkAdded?: Record<string, number>;
}): TravelDataSource {
  const lookup = (
    table: Record<string, number> | undefined,
    a: string,
    b: string,
  ): number | null => {
    if (!table) return null;
    const hit = table[`${a}|${b}`] ?? table[`${b}|${a}`];
    return hit === undefined ? null : hit;
  };
  return {
    distanceMeters: (from, to) => lookup(opts.distances, from.id, to.id),
    carMatrixMinutes: (fromArea, toArea) => lookup(opts.matrix, fromArea, toArea),
    walkAddedMinutes: (from, to) => lookup(opts.walkAdded, from.id, to.id) ?? 0,
  };
}

function makeShift(over: Partial<EngineShift> = {}): EngineShift {
  return {
    startAt: jst(DAY, "10:00"),
    endAt: jst(DAY, "19:00"),
    baseStart: office,
    baseEnd: office,
    areaIds: ["shibuya", "ebisu"],
    maxBookings: null,
    ...over,
  };
}

function makeInput(over: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    therapist: { canUseCar: true, walkCapMeters: 1600 },
    serviceMinutes: 60,
    destination: { place: home, kind: "residence" },
    shift: makeShift(),
    reservations: [],
    // 前日の正午 = リードタイム（90分）がどの枠にもかからない
    now: jst("2026-08-31", "12:00"),
    walkSettings: WALK,
    bufferDefaults: BUFFERS,
    travel: src({ distances: { "base-office|dest-home": 0 } }),
    ...over,
  };
}

describe("1. 空きシフトで、シフト全体が枠になる", () => {
  it("10:00-19:00 シフト・移動0分 → 10:15〜17:45 の15分刻み31枠", () => {
    const slots = computeAvailableSlots(makeInput());
    // s ≥ 10:00 + travel(0) + 到着前10 = 10:10 → 切り上げ 10:15
    // s + 5 + 60 + 10 + travel(0) ≤ 19:00 → s ≤ 17:45
    expect(startTimes(slots)[0]).toBe("10:15");
    expect(startTimes(slots).at(-1)).toBe("17:45");
    expect(slots).toHaveLength(31);
  });

  it("各枠の内訳が exclusion 制約（depart_at〜free_at）に写せる形で返る", () => {
    const slot = computeAvailableSlots(makeInput())[0]!;
    expect(slot.startAt).toEqual(jst(DAY, "10:15"));
    expect(slot.departAt).toEqual(jst(DAY, "10:05")); // s − 到着前10 − travel0
    expect(slot.serviceEndAt).toEqual(jst(DAY, "11:20")); // s + before5 + L60
    expect(slot.freeAt).toEqual(jst(DAY, "11:30")); // s + before5 + L60 + after10
    expect(slot.travelInMin).toBe(0);
    expect(slot.travelInMode).toBe("walk");
    expect(slot.travelOutMin).toBe(0);
    expect(slot.buffers.parkingMin).toBe(0); // 徒歩なので駐車なし
    expect(slot.bufferTotalMin).toBe(25); // arrive10 + before5 + after10
    expect(slot.gapIndex).toBe(0);
  });

  it("shift が無い日（null / is_day_off）は空", () => {
    expect(computeAvailableSlots(makeInput({ shift: null }))).toEqual([]);
  });
});

describe("2. 予約が1本ある日、その前後に移動時間ぶんの余白が空く", () => {
  // 予約先 res-ebisu は目的地から 1200m（徒歩20分: ceil(1200×1.3÷80)）
  const resEbisu: PlaceRef = { id: "res-ebisu", areaId: "ebisu" };
  const input = makeInput({
    reservations: [
      { departAt: jst(DAY, "13:30"), freeAt: jst(DAY, "15:30"), place: resEbisu },
    ],
    travel: src({
      distances: { "base-office|dest-home": 0, "dest-home|res-ebisu": 1200 },
    }),
  });

  it("予約前は「予約の depart_at に移動20分+施術一式が間に合う」枠まで", () => {
    const slots = computeAvailableSlots(input);
    const gap0 = slots.filter((s) => s.gapIndex === 0);
    // s + 75 + travel(home→res 20) ≤ 13:30 → s ≤ 11:55 → 最終枠 11:45
    expect(startTimes(gap0).at(-1)).toBe("11:45");
    expect(startTimes(slots)).not.toContain("12:00");
    expect(gap0.at(-1)!.travelOutMin).toBe(20);
  });

  it("予約後は「free_at + 移動20分 + 到着前10分」から。占有中に枠は出ない", () => {
    const slots = computeAvailableSlots(input);
    const gap1 = slots.filter((s) => s.gapIndex === 1);
    // s ≥ 15:30 + 20 + 10 = 16:00
    expect(startTimes(gap1)[0]).toBe("16:00");
    expect(gap1[0]!.departAt).toEqual(jst(DAY, "15:30")); // free_at ちょうどに出発
    for (const t of ["12:00", "13:30", "14:00", "15:00", "15:45"]) {
      expect(startTimes(slots)).not.toContain(t);
    }
  });

  it("枠は開始時刻の昇順で返る", () => {
    const slots = computeAvailableSlots(input);
    const times = slots.map((s) => s.startAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("3. 隣接エリアなら入るが、遠方エリアだと入らない隙間", () => {
  // 12:00-13:00 と 15:30-16:30 の予約に挟まれた 13:00→15:30 の隙間（150分）
  const between = {
    shift: makeShift({
      startAt: jst(DAY, "11:00"),
      endAt: jst(DAY, "17:30"),
      areaIds: ["shibuya", "ebisu", "hachioji"],
    }),
    reservations: [
      { departAt: jst(DAY, "12:00"), freeAt: jst(DAY, "13:00"), place: res1 },
      { departAt: jst(DAY, "15:30"), freeAt: jst(DAY, "16:30"), place: res2 },
    ],
  };

  it("隣接エリア（徒歩20分）→ 13:30 と 13:45 が入る", () => {
    const destEbisu: PlaceRef = { id: "dest-ebisu", areaId: "ebisu" };
    const slots = computeAvailableSlots(
      makeInput({
        ...between,
        destination: { place: destEbisu, kind: "residence" },
        travel: src({
          distances: {
            "res-1|dest-ebisu": 1200,
            "res-2|dest-ebisu": 1200,
            "base-office|dest-ebisu": 1200,
          },
        }),
      }),
    );
    // s ≥ 13:00 + 20 + 10 = 13:30 / s ≤ 15:30 − 75 − 20 = 13:55
    expect(startTimes(slots)).toEqual(["13:30", "13:45"]);
    expect(slots.every((s) => s.gapIndex === 1)).toBe(true);
  });

  it("遠方エリア（車60分）→ 同じ隙間に1枠も入らない", () => {
    const destFar: PlaceRef = { id: "dest-hachioji", areaId: "hachioji" };
    const slots = computeAvailableSlots(
      makeInput({
        ...between,
        destination: { place: destFar, kind: "residence" },
        travel: src({
          distances: {
            "res-1|dest-hachioji": 34000,
            "res-2|dest-hachioji": 34000,
            "base-office|dest-hachioji": 34000,
          },
          matrix: { "shibuya|hachioji": 60 },
        }),
      }),
    );
    // s ≥ 13:00 + 60 + (10+駐車15) = 14:25 / s ≤ 15:30 − 75 − 60 = 12:15 → 矛盾で空
    expect(slots).toEqual([]);
  });
});

describe("4. 隙間ちょうどに収まる（1分の余裕もない）と、1分足りない", () => {
  // 15:00 に free になり、シフト終了までが隙間。移動0分で 15:15 + 75分 = 16:30
  const base = {
    reservations: [
      { departAt: jst(DAY, "12:00"), freeAt: jst(DAY, "15:00"), place: res1 },
    ],
    travel: src({
      distances: { "base-office|dest-home": 0, "res-1|dest-home": 0 },
    }),
  };

  it("シフト終了 16:30（ちょうど）→ 15:15 の1枠だけ入る", () => {
    const slots = computeAvailableSlots(
      makeInput({
        ...base,
        shift: makeShift({ startAt: jst(DAY, "12:00"), endAt: jst(DAY, "16:30") }),
      }),
    );
    expect(startTimes(slots)).toEqual(["15:15"]);
    // 1分の余裕もない: free_at + travel(0) = 16:30 = シフト終了
    expect(slots[0]!.freeAt).toEqual(jst(DAY, "16:30"));
  });

  it("シフト終了 16:29（1分足りない）→ 空", () => {
    const slots = computeAvailableSlots(
      makeInput({
        ...base,
        shift: makeShift({ startAt: jst(DAY, "12:00"), endAt: jst(DAY, "16:29") }),
      }),
    );
    expect(slots).toEqual([]);
  });
});

describe("5. 徒歩上限(1.6km)の前後で徒歩と車が正しく切り替わる", () => {
  const withDistance = (meters: number, over: Partial<AvailabilityInput> = {}) =>
    makeInput({
      travel: src({
        distances: { "base-office|dest-home": meters },
        matrix: { "shibuya|shibuya": 12 },
      }),
      ...over,
    });

  it("1599m → 徒歩26分（ceil(1599×1.3÷80)）", () => {
    const slot = computeAvailableSlots(withDistance(1599))[0]!;
    expect(slot.travelInMode).toBe("walk");
    expect(slot.travelInMin).toBe(26);
    // s ≥ 10:00 + 26 + 10 = 10:36 → 10:45
    expect(formatInTimeZone(slot.startAt, TZ, "HH:mm")).toBe("10:45");
  });

  it("1601m → 車（マトリクス12分）に切り替わる", () => {
    const slot = computeAvailableSlots(withDistance(1601))[0]!;
    expect(slot.travelInMode).toBe("car");
    expect(slot.travelInMin).toBe(12);
  });

  it("1601m かつ車不可（免許なし）→ 到達不能で空", () => {
    const slots = computeAvailableSlots(
      withDistance(1601, { therapist: { canUseCar: false, walkCapMeters: 1600 } }),
    );
    expect(slots).toEqual([]);
  });

  it("walk_overrides の加算（橋 +12分）が徒歩時間に乗る", () => {
    const slot = computeAvailableSlots(
      makeInput({
        travel: src({
          distances: { "base-office|dest-home": 800 }, // 素の徒歩13分
          walkAdded: { "base-office|dest-home": 12 },
        }),
      }),
    )[0]!;
    expect(slot.travelInMin).toBe(25); // 13 + 12
  });
});

describe("6. 深夜の車係数で移動が短くなり、昼は入らない枠が入る", () => {
  // 車60分の遠方エリア。8時間シフトの終端で「帰りの移動」が縮むかどうかが効く
  const destFar: PlaceRef = { id: "dest-far", areaId: "hachioji" };
  const farTravel = src({
    distances: { "base-office|dest-far": 34000 },
    matrix: { "shibuya|hachioji": 60 },
  });
  const nightShift = makeShift({
    startAt: jst(DAY, "17:00"),
    endAt: jst(NEXT_DAY, "01:00"), // 日跨ぎシフト
    areaIds: ["shibuya", "hachioji"],
  });

  it("深夜係数あり: 23:00 開始が入る（帰路 60分 → 45分に短縮され 01:00 ちょうどに帰着）", () => {
    const slots = computeAvailableSlots(
      makeInput({
        shift: nightShift,
        destination: { place: destFar, kind: "residence" },
        travel: farTravel,
        timeModifiers: NIGHT_MODS,
      }),
    );
    expect(startTimes(slots)).toContain("23:00");
    const last = slots.at(-1)!;
    expect(formatInTimeZone(last.startAt, TZ, "HH:mm")).toBe("23:00");
    expect(last.travelOutMin).toBe(45); // ceil(60 × 0.75)
  });

  it("係数なし（昼と同じ扱い）: 23:00 は帰れず 22:45 まで", () => {
    const slots = computeAvailableSlots(
      makeInput({
        shift: nightShift,
        destination: { place: destFar, kind: "residence" },
        travel: farTravel,
        timeModifiers: [],
      }),
    );
    expect(startTimes(slots)).not.toContain("23:00");
    expect(startTimes(slots).at(-1)).toBe("22:45");
  });

  it("同じ長さの昼シフトでは相当する枠（開始+6h）が入らない", () => {
    const slots = computeAvailableSlots(
      makeInput({
        shift: makeShift({
          startAt: jst(DAY, "11:00"),
          endAt: jst(DAY, "19:00"),
          areaIds: ["shibuya", "hachioji"],
        }),
        destination: { place: destFar, kind: "residence" },
        travel: farTravel,
        timeModifiers: NIGHT_MODS, // 係数はあるが昼間は該当しない
      }),
    );
    // 深夜シフトの 23:00（開始+6h）に相当する 17:00 は、帰路60分のままなので入らない
    expect(startTimes(slots)).not.toContain("17:00");
    expect(startTimes(slots).at(-1)).toBe("16:45");
  });
});

describe("7. 駐車バッファが車のときだけ加算される", () => {
  it("徒歩: parkingMin=0 / depart_at = s − 10 − 徒歩分", () => {
    const slot = computeAvailableSlots(
      makeInput({
        travel: src({ distances: { "base-office|dest-home": 1599 } }),
      }),
    )[0]!;
    expect(slot.buffers.parkingMin).toBe(0);
    expect(slot.buffers.arrivalTotalMin).toBe(10);
    expect(slot.departAt).toEqual(
      new Date(slot.startAt.getTime() - (10 + slot.travelInMin) * 60_000),
    );
  });

  it("車: parkingMin=15 が到着側に積まれ depart_at = s − 25 − 車分", () => {
    const slot = computeAvailableSlots(
      makeInput({
        travel: src({
          distances: { "base-office|dest-home": 1601 },
          matrix: { "shibuya|shibuya": 12 },
        }),
      }),
    )[0]!;
    expect(slot.buffers.parkingMin).toBe(15);
    expect(slot.buffers.arrivalTotalMin).toBe(25);
    expect(slot.departAt).toEqual(
      new Date(slot.startAt.getTime() - (25 + slot.travelInMin) * 60_000),
    );
  });
});

describe("8. シフト終端で「帰れない」枠が除外される", () => {
  it("待機終了場所 B_end への帰路（車30分）ぶん、終端の枠が消える", () => {
    const baseHome: PlaceRef = { id: "base-home", areaId: "meguro" };
    const slots = computeAvailableSlots(
      makeInput({
        shift: makeShift({ baseEnd: baseHome }),
        travel: src({
          distances: {
            "base-office|dest-home": 0,
            "dest-home|base-home": 34000,
          },
          matrix: { "shibuya|meguro": 30 },
        }),
      }),
    );
    // s + 75 + 帰路30 ≤ 19:00 → s ≤ 17:15（B_end=office の 17:45 から2枠減る）
    expect(startTimes(slots).at(-1)).toBe("17:15");
    expect(startTimes(slots)).not.toContain("17:30");
    expect(startTimes(slots)).not.toContain("17:45");
    expect(slots.at(-1)!.travelOutMode).toBe("car");
  });
});

describe("9. 上限本数に達した日", () => {
  const twoReservations = [
    { departAt: jst(DAY, "12:00"), freeAt: jst(DAY, "13:00"), place: res1 },
    { departAt: jst(DAY, "15:00"), freeAt: jst(DAY, "16:00"), place: res1 },
  ];
  const travel = src({
    distances: { "base-office|dest-home": 0, "res-1|dest-home": 0 },
  });

  it("max_bookings=2 で予約2本 → 隙間があっても空", () => {
    const slots = computeAvailableSlots(
      makeInput({
        shift: makeShift({ maxBookings: 2 }),
        reservations: twoReservations,
        travel,
      }),
    );
    expect(slots).toEqual([]);
  });

  it("max_bookings=3 なら同じ日でも枠が出る", () => {
    const slots = computeAvailableSlots(
      makeInput({
        shift: makeShift({ maxBookings: 3 }),
        reservations: twoReservations,
        travel,
      }),
    );
    expect(slots.length).toBeGreaterThan(0);
  });
});

describe("10. 対応エリア外", () => {
  it("A が shift_areas に無い → 空（出勤していても受けない）", () => {
    const slots = computeAvailableSlots(
      makeInput({
        destination: { place: { id: "dest-x", areaId: "hachioji" }, kind: "residence" },
      }),
    );
    expect(slots).toEqual([]);
  });
});

describe("11. 日跨ぎの予約（23:30開始120分コース）", () => {
  // 17:00〜翌04:00 のシフト。23:30 開始 120分 → depart 23:00 / free 翌01:55
  const input = makeInput({
    shift: makeShift({ startAt: jst(DAY, "17:00"), endAt: jst(NEXT_DAY, "04:00") }),
    reservations: [
      { departAt: jst(DAY, "23:00"), freeAt: jst(NEXT_DAY, "01:55"), place: res1 },
    ],
    travel: src({
      distances: { "base-office|dest-home": 0, "res-1|dest-home": 0 },
    }),
  });

  it("予約前の枠は 23:00 の depart_at 手前まで、予約後は翌日 02:15 から", () => {
    const slots = computeAvailableSlots(input);
    const stamps = startStamps(slots);
    // gap0: s ≤ 23:00 − 75 = 21:45
    expect(stamps).toContain("09-01 21:45");
    expect(stamps).not.toContain("09-01 22:00");
    // gap1: s ≥ 01:55 + 10 = 02:05 → 02:15。締切 04:00 − 75 = 02:45
    const gap1 = slots.filter((s) => s.gapIndex === 1);
    expect(startStamps(gap1)).toEqual(["09-02 02:15", "09-02 02:30", "09-02 02:45"]);
  });

  it("15分グリッドが日付を跨いでも壁時計の :00/:15/:30/:45 に揃う", () => {
    const slots = computeAvailableSlots(input);
    for (const s of slots) {
      expect(["00", "15", "30", "45"]).toContain(formatInTimeZone(s.startAt, TZ, "mm"));
    }
  });
});

describe("12. 現在時刻が進むと、リードタイム内の枠が消える", () => {
  it("now=09:00 → 10:30 から（90分ルールで 10:15 が消える）", () => {
    const slots = computeAvailableSlots(makeInput({ now: jst(DAY, "09:00") }));
    expect(startTimes(slots)[0]).toBe("10:30");
  });

  it("now=12:00 に進むと 13:30 より前が全部消える", () => {
    const earlier = computeAvailableSlots(makeInput({ now: jst(DAY, "09:00") }));
    const later = computeAvailableSlots(makeInput({ now: jst(DAY, "12:00") }));
    expect(startTimes(later)[0]).toBe("13:30");
    expect(startTimes(earlier)).toContain("10:30");
    expect(startTimes(later)).not.toContain("10:30");
    expect(later.length).toBeLessThan(earlier.length);
  });

  it("リードタイムは leadTimeMin で調整できる（既定90分）", () => {
    const slots = computeAvailableSlots(makeInput({ now: jst(DAY, "09:00"), leadTimeMin: 0 }));
    expect(startTimes(slots)[0]).toBe("10:15");
  });
});

describe("ホテル: extra_minutes が到着バッファに加算され、空き枠が変わる（spec 8-2 / 14章 #9）", () => {
  it("館内移動12分 → 最初の枠が 10:15 から 10:30 に後ろへずれる", () => {
    const residence = computeAvailableSlots(makeInput());
    const hotel = computeAvailableSlots(
      makeInput({
        destination: { place: home, kind: "hotel", hotelExtraMinutes: 12 },
      }),
    );
    expect(startTimes(residence)[0]).toBe("10:15");
    // s ≥ 10:00 + 0 + (10 + 12) = 10:22 → 10:30
    expect(startTimes(hotel)[0]).toBe("10:30");
    expect(hotel[0]!.buffers.hotelExtraMin).toBe(12);
    expect(hotel[0]!.buffers.arrivalTotalMin).toBe(22);
  });
});

describe("オプション: duration_min が L に効いて終端の枠が減る（spec 5-3 / 15章）", () => {
  it("60分コース + 30分オプション → L=90 で最終枠が 17:45 → 17:15", () => {
    const l60 = computeAvailableSlots(makeInput({ serviceMinutes: 60 }));
    const l90 = computeAvailableSlots(
      makeInput({ serviceMinutes: totalServiceMinutes(60, [{ durationMin: 30 }]) }),
    );
    expect(startTimes(l60).at(-1)).toBe("17:45");
    expect(startTimes(l90).at(-1)).toBe("17:15");
  });
});

describe("手順8: held/confirmed の占有区間（depart_at〜free_at）と重複する枠の除外", () => {
  it("12:00〜13:00 のホールドと重なる枠だけが消える（区間は半開）", () => {
    const slots = computeAvailableSlots(
      makeInput({
        holds: [{ departAt: jst(DAY, "12:00"), freeAt: jst(DAY, "13:00") }],
      }),
    );
    const times = startTimes(slots);
    // 10:45 は free_at=12:00 ちょうど（半開区間なので接触は重複でない）
    expect(times).toContain("10:45");
    // 11:00〜13:00 は depart〜free がホールドに食い込む
    for (const t of ["11:00", "11:30", "12:00", "12:30", "13:00"]) {
      expect(times).not.toContain(t);
    }
    // 13:15 は depart_at=13:05 ≥ ホールド終端
    expect(times).toContain("13:15");
  });
});

describe("到着側の車係数が固定点で振動する場合、遅刻側に倒さない（reviewer R-1）", () => {
  // 朝ピーク 07:00-09:30 ×1.4。車マトリクス60分。目的地=別エリア(ebisu)で car。
  const PEAK: TimeModifier[] = [
    { timeFrom: "07:00", timeTo: "09:30", multiplier: 1.4, additional: 0 },
  ];
  const destEbisu: PlaceRef = { id: "dest-ebisu", areaId: "ebisu" };

  it("s=08:30 の到着分は 84/60 で振動 → max=84 を採り depart_at=06:41（甘い60を採らない）", () => {
    const slots = computeAvailableSlots(
      makeInput({
        destination: { place: destEbisu, kind: "residence" },
        // 早朝から開始し、depart_at=06:41 が gap.tP 以降・now 以降になるように
        shift: makeShift({ startAt: jst(DAY, "06:00"), endAt: jst(DAY, "19:00") }),
        timeModifiers: PEAK,
        travel: src({
          distances: { "base-office|dest-ebisu": 3000 }, // >1600m → car
          matrix: { "shibuya|ebisu": 60 },
        }),
        now: jst("2026-08-31", "12:00"),
      }),
    );
    const s0830 = slots.find(
      (s) => formatInTimeZone(s.startAt, TZ, "HH:mm") === "08:30",
    );
    expect(s0830).toBeDefined();
    expect(s0830!.travelInMode).toBe("car");
    // arriveBy = 08:30 − (到着10 + 駐車15) = 08:05。係数境界を跨ぐ振動でも遅刻側に倒さず 84 分。
    expect(s0830!.travelInMin).toBe(84);
    // depart_at = 08:05 − 84 = 06:41（甘い60なら 07:05 になってしまう）
    expect(formatInTimeZone(s0830!.departAt, TZ, "HH:mm")).toBe("06:41");
  });
});

describe("5-4. 最短で案内できる時間（earliestAvailable / slotTimeLabel）", () => {
  it("now 起点で最初の1件を返す", () => {
    const slot = earliestAvailable(makeInput({ now: jst(DAY, "09:00") }));
    expect(slot).not.toBeNull();
    expect(slotTimeLabel(slot!)).toBe("10:30");
  });

  it("1件も無ければ null", () => {
    expect(earliestAvailable(makeInput({ shift: null }))).toBeNull();
  });
});

describe("入力の検証", () => {
  it("serviceMinutes が正の整数でなければ RangeError", () => {
    expect(() => computeAvailableSlots(makeInput({ serviceMinutes: 0 }))).toThrow(RangeError);
    expect(() => computeAvailableSlots(makeInput({ serviceMinutes: 60.5 }))).toThrow(RangeError);
  });

  it("slotStepMin は 60 の約数のみ", () => {
    expect(() => computeAvailableSlots(makeInput({ slotStepMin: 7 }))).toThrow(RangeError);
  });

  it("目的地に areaId が無ければ RangeError（対応エリア判定ができない）", () => {
    expect(() =>
      computeAvailableSlots(
        makeInput({
          destination: { place: { id: "dest-x", areaId: null }, kind: "residence" },
        }),
      ),
    ).toThrow(RangeError);
  });
});
