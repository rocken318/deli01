import { describe, expect, it } from "vitest";
import { sanitizeNext } from "./next-path";

describe("sanitizeNext", () => {
  it("同一オリジンの相対パスは通す", () => {
    expect(sanitizeNext("/admin/accounting")).toBe("/admin/accounting");
    expect(sanitizeNext("/mypage")).toBe("/mypage");
  });
  it("未指定・空はフォールバック /admin", () => {
    expect(sanitizeNext(undefined)).toBe("/admin");
    expect(sanitizeNext("")).toBe("/admin");
  });
  it("プロトコル相対 // とスキーム付き絶対 URL は拒否", () => {
    expect(sanitizeNext("//evil.example")).toBe("/admin");
    expect(sanitizeNext("https://evil.example")).toBe("/admin");
    expect(sanitizeNext("http://evil.example")).toBe("/admin");
  });
  it("バックスラッシュ・改行等の細工は拒否", () => {
    expect(sanitizeNext("/\\evil")).toBe("/admin");
    expect(sanitizeNext("/admin\nfoo")).toBe("/admin");
  });
  it("/ で始まらないものは拒否", () => {
    expect(sanitizeNext("admin")).toBe("/admin");
  });
});
