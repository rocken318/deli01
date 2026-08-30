import { describe, it, expect } from "vitest";
import { canExtend } from "./extension";

/**
 * 当日延長の可否判定（フェーズ15 / 完了条件・受入 L1100）。
 */
describe("canExtend – 当日延長の可否（受入 L1100）", () => {
  const free = new Date("2026-09-02T05:00:00.000Z"); // 占有上端

  it("後続予約が無ければ常に可（newFreeAt は延長分だけ後ろ）", () => {
    const r = canExtend({ currentFreeAt: free, addedMinutes: 30, nextDepartAt: null });
    expect(r.ok).toBe(true);
    expect(r.newFreeAt.getTime()).toBe(free.getTime() + 30 * 60_000);
    expect(r.shortfallMin).toBeUndefined();
  });

  it("延長後 free_at が後続 depart_at より前なら可", () => {
    const next = new Date(free.getTime() + 60 * 60_000); // 60分後
    const r = canExtend({ currentFreeAt: free, addedMinutes: 30, nextDepartAt: next });
    expect(r.ok).toBe(true);
  });

  it("延長後 free_at == 後続 depart_at は隣接で可（半開区間 '[)'）", () => {
    const next = new Date(free.getTime() + 30 * 60_000);
    const r = canExtend({ currentFreeAt: free, addedMinutes: 30, nextDepartAt: next });
    expect(r.ok).toBe(true);
  });

  it("★ 延長後 free_at が後続 depart_at を超えると不可・不足分を返す（完了条件）", () => {
    const next = new Date(free.getTime() + 20 * 60_000); // 20分後に後続
    const r = canExtend({ currentFreeAt: free, addedMinutes: 30, nextDepartAt: next });
    expect(r.ok).toBe(false);
    expect(r.shortfallMin).toBe(10); // 30分延長 - 20分猶予 = 10分不足
  });

  it("不足分は分単位で切り上げる", () => {
    const next = new Date(free.getTime() + 20 * 60_000 + 30_000); // 20分30秒後
    const r = canExtend({ currentFreeAt: free, addedMinutes: 30, nextDepartAt: next });
    expect(r.ok).toBe(false);
    expect(r.shortfallMin).toBe(10); // 9分30秒 → 切り上げ 10
  });

  it("addedMinutes=0 は変化なしで可", () => {
    const next = new Date(free.getTime()); // ちょうど free に接する後続
    const r = canExtend({ currentFreeAt: free, addedMinutes: 0, nextDepartAt: next });
    expect(r.ok).toBe(true);
    expect(r.newFreeAt.getTime()).toBe(free.getTime());
  });

  it("負の addedMinutes は RangeError", () => {
    expect(() =>
      canExtend({ currentFreeAt: free, addedMinutes: -1, nextDepartAt: null }),
    ).toThrow(RangeError);
  });
});
