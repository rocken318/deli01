/**
 * キャンセル待ち通知のユニットテスト（受入 L1122）。
 * DB 依存のない純関数部分（dedupe_key・パラメータバリデーション）だけテストする。
 * DB を使う統合テストは統合テストフェーズで追加する。
 */

import { describe, it, expect } from "vitest";
import { waitlistDedupeKey } from "./waitlist";

describe("waitlistDedupeKey（受入 L1122: 同日の同じ待ちには1通だけ）", () => {
  it("'waitlist_open:{waitlist_id}:{dateISO}' 形式になる", () => {
    const key = waitlistDedupeKey("wl-uuid-1234", "2026-09-10");
    expect(key).toBe("waitlist_open:wl-uuid-1234:2026-09-10");
  });

  it("日付が違えばキーが違う（別日は再通知してよい）", () => {
    const key1 = waitlistDedupeKey("wl-uuid-1234", "2026-09-10");
    const key2 = waitlistDedupeKey("wl-uuid-1234", "2026-09-11");
    expect(key1).not.toBe(key2);
  });

  it("waitlist_id が違えばキーが違う", () => {
    const key1 = waitlistDedupeKey("wl-uuid-1111", "2026-09-10");
    const key2 = waitlistDedupeKey("wl-uuid-2222", "2026-09-10");
    expect(key1).not.toBe(key2);
  });
});
