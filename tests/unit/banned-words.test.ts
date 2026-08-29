import { describe, expect, it } from "vitest";
import { checkBannedWords } from "@/domain/cms/banned-words";

describe("checkBannedWords", () => {
  it("禁止語が含まれていない場合は空配列を返す", () => {
    expect(checkBannedWords("ボディケアで疲れを癒します", ["治療", "治る"])).toEqual([]);
  });

  it("禁止語が含まれる場合、マッチした語のリストを返す", () => {
    const result = checkBannedWords("肩こりが治ります。治療効果があります", ["治ります", "治療", "効果"]);
    expect(result).toContain("治ります");
    expect(result).toContain("治療");
    expect(result).toContain("効果");
    expect(result.length).toBe(3);
  });

  it("大文字小文字を区別せずにチェックする", () => {
    expect(checkBannedWords("Medical effect", ["medical"])).toContain("medical");
  });

  it("同じ禁止語が複数回出てきても1件だけ返す", () => {
    expect(checkBannedWords("治る治る", ["治る"]).length).toBe(1);
  });

  it("禁止語リストが空の場合は常に空配列", () => {
    expect(checkBannedWords("何でも書ける", [])).toEqual([]);
  });

  it("テキストが空文字の場合は空配列", () => {
    expect(checkBannedWords("", ["治る"])).toEqual([]);
  });
});
