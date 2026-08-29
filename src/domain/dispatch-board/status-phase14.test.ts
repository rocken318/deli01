import { describe, expect, it } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import {
  DISPATCH_FLOW,
  TAP_TIMESTAMP_COLUMNS,
  canTransition,
  isDelayed,
  isDispatchStatus,
  isExitOverdue,
  nextStatus,
} from "./status";

/**
 * 配車ボード純関数の完全網羅テスト（フェーズ14 QA拡充）。
 * 既存の status.test.ts に追加せず別ファイルで網羅。
 * spec 7-1・7-3・受入 L1066 の全ケース。
 */

const TZ = "Asia/Tokyo";
const jst = (s: string): Date => fromZonedTime(s, TZ);

// テスト用の全ステータス（DispatchFlow 外も含む）
const ALL_STATUSES = ["confirmed", "enroute", "in_service", "done", "held", "cancelled", "noshow"] as const;

// =====================================================================
// nextStatus の全値
// =====================================================================
describe("nextStatus: 全値の返り値を網羅", () => {
  it("confirmed -> enroute", () => {
    expect(nextStatus("confirmed")).toBe("enroute");
  });
  it("enroute -> in_service", () => {
    expect(nextStatus("enroute")).toBe("in_service");
  });
  it("in_service -> done", () => {
    expect(nextStatus("in_service")).toBe("done");
  });
  it("done（終端） -> null", () => {
    expect(nextStatus("done")).toBeNull();
  });
  it("held -> null（dispatch flow 外）", () => {
    expect(nextStatus("held")).toBeNull();
  });
  it("cancelled -> null（dispatch flow 外）", () => {
    expect(nextStatus("cancelled")).toBeNull();
  });
  it("noshow -> null（dispatch flow 外）", () => {
    expect(nextStatus("noshow")).toBeNull();
  });
  it("未知文字列 -> null", () => {
    expect(nextStatus("bogus")).toBeNull();
    expect(nextStatus("")).toBeNull();
    expect(nextStatus("CONFIRMED")).toBeNull(); // 大文字は別物
  });
});

// =====================================================================
// canTransition: 全ペア総当たり（7 × 7 = 49 ペア）
// 許可は3ペアのみ: confirmed→enroute / enroute→in_service / in_service→done
// =====================================================================
describe("canTransition: 全ペア総当たり", () => {
  const ALLOWED_PAIRS: [string, string][] = [
    ["confirmed", "enroute"],
    ["enroute", "in_service"],
    ["in_service", "done"],
  ];

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const shouldAllow = ALLOWED_PAIRS.some(([f, t]) => f === from && t === to);
      it(`${from} -> ${to}: ${shouldAllow ? "true（許可）" : "false（不可）"}`, () => {
        expect(canTransition(from, to)).toBe(shouldAllow);
      });
    }
  }

  it("未知文字列 -> 未知文字列は false", () => {
    expect(canTransition("bogus", "bogus")).toBe(false);
    expect(canTransition("", "enroute")).toBe(false);
    expect(canTransition("confirmed", "")).toBe(false);
  });
});

// =====================================================================
// isDispatchStatus: ガード関数
// =====================================================================
describe("isDispatchStatus: ガード", () => {
  it("DISPATCH_FLOW の4値は true", () => {
    for (const s of DISPATCH_FLOW) {
      expect(isDispatchStatus(s)).toBe(true);
    }
  });
  it("held/cancelled/noshow/未知 は false", () => {
    expect(isDispatchStatus("held")).toBe(false);
    expect(isDispatchStatus("cancelled")).toBe(false);
    expect(isDispatchStatus("noshow")).toBe(false);
    expect(isDispatchStatus("bogus")).toBe(false);
    expect(isDispatchStatus("")).toBe(false);
    expect(isDispatchStatus("CONFIRMED")).toBe(false);
  });
});

// =====================================================================
// isDelayed: 境界値の網羅（spec 7-1 L691「移動中のまま予定開始時刻を過ぎたら赤」）
// =====================================================================
describe("isDelayed: 境界値の完全網羅", () => {
  const startAt = jst("2026-09-01T14:00:00");

  it("enroute かつ now > startAt（1秒超過）= true", () => {
    expect(isDelayed({ status: "enroute", startAt, now: jst("2026-09-01T14:00:01") })).toBe(true);
  });
  it("enroute かつ now == startAt（境界同時刻）= false（同時刻は遅延でない）", () => {
    expect(isDelayed({ status: "enroute", startAt, now: jst("2026-09-01T14:00:00") })).toBe(false);
  });
  it("enroute かつ now < startAt（1秒前）= false", () => {
    expect(isDelayed({ status: "enroute", startAt, now: jst("2026-09-01T13:59:59") })).toBe(false);
  });
  it("enroute かつ now << startAt（大幅前）= false", () => {
    expect(isDelayed({ status: "enroute", startAt, now: jst("2026-09-01T10:00:00") })).toBe(false);
  });
  it("enroute かつ now >> startAt（大幅超過）= true", () => {
    expect(isDelayed({ status: "enroute", startAt, now: jst("2026-09-01T18:00:00") })).toBe(true);
  });

  // enroute 以外は全て false
  for (const status of ALL_STATUSES.filter((s) => s !== "enroute")) {
    it(`${status} × now >> startAt = false（enroute 以外は遅延にしない）`, () => {
      expect(isDelayed({ status, startAt, now: jst("2026-09-01T18:00:00") })).toBe(false);
    });
  }
  it("未知 status × now >> startAt = false", () => {
    expect(isDelayed({ status: "bogus", startAt, now: jst("2026-09-01T18:00:00") })).toBe(false);
  });
});

// =====================================================================
// isExitOverdue: 境界値の網羅（spec 7-3 L705「退出予定を過ぎて退出記録が無ければアラート」）
// =====================================================================
describe("isExitOverdue: 境界値の完全網羅", () => {
  const endAt = jst("2026-09-01T15:30:00");

  // in_service: 施術中のまま endAt を超過
  it("in_service かつ now > endAt（1秒超過）= true（アラート）", () => {
    expect(isExitOverdue({ status: "in_service", endAt, now: jst("2026-09-01T15:30:01") })).toBe(true);
  });
  it("in_service かつ now == endAt（境界同時刻）= false（ちょうどは猶予）", () => {
    expect(isExitOverdue({ status: "in_service", endAt, now: jst("2026-09-01T15:30:00") })).toBe(false);
  });
  it("in_service かつ now < endAt（1秒前）= false", () => {
    expect(isExitOverdue({ status: "in_service", endAt, now: jst("2026-09-01T15:29:59") })).toBe(false);
  });
  it("in_service かつ now << endAt（大幅前）= false", () => {
    expect(isExitOverdue({ status: "in_service", endAt, now: jst("2026-09-01T13:00:00") })).toBe(false);
  });
  it("in_service かつ now >> endAt（大幅超過）= true", () => {
    expect(isExitOverdue({ status: "in_service", endAt, now: jst("2026-09-01T17:00:00") })).toBe(true);
  });

  // enroute: 開始遅延がそのまま続いた形（移動中のまま終了予定超過）
  it("enroute かつ now > endAt = true（移動中のまま退出予定超過）", () => {
    expect(isExitOverdue({ status: "enroute", endAt, now: jst("2026-09-01T15:30:01") })).toBe(true);
  });
  it("enroute かつ now == endAt = false", () => {
    expect(isExitOverdue({ status: "enroute", endAt, now: jst("2026-09-01T15:30:00") })).toBe(false);
  });
  it("enroute かつ now < endAt = false", () => {
    expect(isExitOverdue({ status: "enroute", endAt, now: jst("2026-09-01T14:00:00") })).toBe(false);
  });

  // done: 退出記録済みはアラートしない
  it("done × now >> endAt = false（退出記録済み）", () => {
    expect(isExitOverdue({ status: "done", endAt, now: jst("2026-09-01T17:00:00") })).toBe(false);
  });

  // confirmed: 出発前は退出アラートの対象外
  it("confirmed × now >> endAt = false（出発前）", () => {
    expect(isExitOverdue({ status: "confirmed", endAt, now: jst("2026-09-01T17:00:00") })).toBe(false);
  });

  // held / cancelled / noshow
  for (const status of ["held", "cancelled", "noshow"] as const) {
    it(`${status} × now >> endAt = false`, () => {
      expect(isExitOverdue({ status, endAt, now: jst("2026-09-01T17:00:00") })).toBe(false);
    });
  }

  it("未知 status × now >> endAt = false", () => {
    expect(isExitOverdue({ status: "bogus", endAt, now: jst("2026-09-01T17:00:00") })).toBe(false);
  });
});

// =====================================================================
// TAP_TIMESTAMP_COLUMNS: 各 toStatus に対して記録列が正しい
// =====================================================================
describe("TAP_TIMESTAMP_COLUMNS: toStatus ごとの記録列", () => {
  it("enroute -> ['enroute_at']", () => {
    expect(TAP_TIMESTAMP_COLUMNS["enroute"]).toEqual(["enroute_at"]);
  });
  it("in_service -> ['arrived_at', 'service_started_at']（到着未記録の補完あり）", () => {
    expect(TAP_TIMESTAMP_COLUMNS["in_service"]).toEqual(["arrived_at", "service_started_at"]);
  });
  it("done -> ['done_at']", () => {
    expect(TAP_TIMESTAMP_COLUMNS["done"]).toEqual(["done_at"]);
  });
  it("confirmed は TAP_TIMESTAMP_COLUMNS にキーが無い（初期値であり遷移先でない）", () => {
    expect("confirmed" in TAP_TIMESTAMP_COLUMNS).toBe(false);
  });
});
