import { describe, expect, it } from "vitest";
import { sanitizeNext, defaultDestForRole } from "./next-path";

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
  it("fallback を渡すと未指定・不正時はそれに倒す（ロール別着地に使う）", () => {
    expect(sanitizeNext(undefined, "/mypage")).toBe("/mypage");
    expect(sanitizeNext("", "/mypage")).toBe("/mypage");
    expect(sanitizeNext("//evil", "/mypage")).toBe("/mypage");
    // 有効な相対パスは fallback に関係なく通す
    expect(sanitizeNext("/mypage/punch", "/admin")).toBe("/mypage/punch");
  });
});

describe("defaultDestForRole", () => {
  it("therapist は /mypage、それ以外は /admin", () => {
    expect(defaultDestForRole("therapist")).toBe("/mypage");
    expect(defaultDestForRole("owner")).toBe("/admin");
    expect(defaultDestForRole("admin")).toBe("/admin");
    expect(defaultDestForRole("reception")).toBe("/admin");
    expect(defaultDestForRole(undefined)).toBe("/admin");
    expect(defaultDestForRole(null)).toBe("/admin");
  });
});
