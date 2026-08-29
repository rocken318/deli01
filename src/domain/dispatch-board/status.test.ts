import { describe, expect, it } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import {
  canTransition,
  isDelayed,
  isExitOverdue,
  nextStatus,
} from "./status";

/**
 * 配車ボード純関数の最小テスト（フェーズ14）。
 * 網羅（全ペアの遷移表・境界値の総当たり）は qa フェーズで拡充する。
 * 観点は最終報告の「qa への申し送り」参照。
 */

const TZ = "Asia/Tokyo";
const jst = (s: string): Date => fromZonedTime(s, TZ);

describe("nextStatus / canTransition（隣接前進のみ）", () => {
  it("confirmed→enroute→in_service→done の順にのみ進む", () => {
    expect(nextStatus("confirmed")).toBe("enroute");
    expect(nextStatus("enroute")).toBe("in_service");
    expect(nextStatus("in_service")).toBe("done");
    expect(nextStatus("done")).toBeNull();
  });

  it("流れ外のステータス（held/cancelled/noshow/未知）は進められない", () => {
    expect(nextStatus("held")).toBeNull();
    expect(nextStatus("cancelled")).toBeNull();
    expect(nextStatus("noshow")).toBeNull();
    expect(nextStatus("bogus")).toBeNull();
  });

  it("後退・スキップは不可", () => {
    expect(canTransition("confirmed", "enroute")).toBe(true);
    expect(canTransition("enroute", "confirmed")).toBe(false); // 後退
    expect(canTransition("confirmed", "in_service")).toBe(false); // スキップ
    expect(canTransition("confirmed", "done")).toBe(false); // スキップ
    expect(canTransition("done", "done")).toBe(false); // 同一
    expect(canTransition("in_service", "cancelled")).toBe(false); // 流れ外（フェーズ15）
  });
});

describe("isDelayed（spec 7-1: 移動中のまま予定開始を過ぎたら赤）", () => {
  const startAt = jst("2026-09-01T14:00:00");

  it("enroute かつ now > startAt で遅延。同時刻は遅延でない", () => {
    expect(isDelayed({ status: "enroute", startAt, now: jst("2026-09-01T14:00:01") })).toBe(true);
    expect(isDelayed({ status: "enroute", startAt, now: jst("2026-09-01T14:00:00") })).toBe(false);
    expect(isDelayed({ status: "enroute", startAt, now: jst("2026-09-01T13:59:00") })).toBe(false);
  });

  it("enroute 以外は遅延にしない（in_service = 開始済み）", () => {
    expect(isDelayed({ status: "in_service", startAt, now: jst("2026-09-01T15:00:00") })).toBe(false);
    expect(isDelayed({ status: "confirmed", startAt, now: jst("2026-09-01T15:00:00") })).toBe(false);
  });
});

describe("isExitOverdue（spec 7-3: 退出予定を過ぎて退出記録が無ければアラート）", () => {
  const endAt = jst("2026-09-01T15:30:00");

  it("in_service のまま end_at を過ぎたらアラート", () => {
    expect(isExitOverdue({ status: "in_service", endAt, now: jst("2026-09-01T15:31:00") })).toBe(true);
    expect(isExitOverdue({ status: "in_service", endAt, now: jst("2026-09-01T15:30:00") })).toBe(false);
  });

  it("done（退出記録済み）はアラートしない", () => {
    expect(isExitOverdue({ status: "done", endAt, now: jst("2026-09-01T16:00:00") })).toBe(false);
  });
});
