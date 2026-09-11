import { describe, it, expect } from "vitest";
import { buildDispatchLineTexts } from "./line-texts";

const base = {
  therapistName: "あゆ",
  destination: "伽羅（キャラ）",
  direction: "六丁目・仙台新港",
  departText: "20:00",
  outText: "22:27",
  roomNumber: "302",
  customerPhone: "09012345678",
  meetupPlace: "事務所下",
};

describe("buildDispatchLineTexts", () => {
  it("4種を返す", () => {
    const t = buildDispatchLineTexts(base);
    expect(t.sendDriver).toContain("送り");
    expect(t.sendWoman).toContain("あゆ");
    expect(t.catchDriver).toContain("キャッチ");
    expect(t.catchWoman).toContain("お迎え");
  });
  it("運転手向けは部屋番号・電話を含み、女性向けは電話を含まない", () => {
    const t = buildDispatchLineTexts(base);
    expect(t.sendDriver).toContain("302");
    expect(t.catchDriver).toContain("09012345678");
    expect(t.sendWoman).not.toContain("09012345678");
    expect(t.catchWoman).not.toContain("09012345678");
  });
  it("方面は場所に併記される", () => {
    const t = buildDispatchLineTexts(base);
    expect(t.sendDriver).toContain("六丁目・仙台新港");
  });
  it("欠損値でも落ちない（空で埋める）", () => {
    const t = buildDispatchLineTexts({ therapistName: "りく", destination: "自宅送り:人来田" });
    expect(t.sendDriver).toContain("りく");
    expect(typeof t.catchWoman).toBe("string");
  });
});
