import { describe, expect, it } from "vitest";
import {
  blockSchema,
  blocksArraySchema,
  BLOCK_TYPES,
} from "@/domain/cms/blocks";

describe("blockSchema", () => {
  it("hero ブロックが valid になる", () => {
    const input = {
      id: "b1",
      type: "hero",
      visible: true,
      heading: "ようこそ",
      subheading: "リラクゼーションサービス",
      imageId: null,
      ctaLabel: "予約する",
      ctaHref: "/booking",
    };
    expect(blockSchema.safeParse(input).success).toBe(true);
  });

  it("text ブロックが valid になる", () => {
    expect(blockSchema.safeParse({ id: "b2", type: "text", visible: true, body: "テキスト" }).success).toBe(true);
  });

  it("image ブロックが valid になる", () => {
    expect(blockSchema.safeParse({ id: "b3", type: "image", visible: true, imageId: "uuid-1", alt: "説明" }).success).toBe(true);
  });

  it("play ブロックが valid になる（項目は body の配列）", () => {
    const input = {
      id: "b5",
      type: "play",
      visible: true,
      heading: "プレイ内容",
      items: [{ body: "内容1" }, { body: "内容2" }],
    };
    expect(blockSchema.safeParse(input).success).toBe(true);
  });

  it("play ブロックの items は既定で空配列", () => {
    const parsed = blockSchema.safeParse({ id: "b6", type: "play", visible: true });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "play") {
      expect(parsed.data.items).toEqual([]);
    }
  });

  it("ホワイトリスト外の type は invalid になる", () => {
    expect(blockSchema.safeParse({ id: "b4", type: "custom_unknown", visible: true }).success).toBe(false);
  });

  it("id が無いブロックは invalid", () => {
    expect(blockSchema.safeParse({ type: "hero", visible: true, heading: "h" }).success).toBe(false);
  });

  it("blocksArraySchema でブロック配列を検証できる", () => {
    const arr = [
      { id: "b1", type: "hero", visible: true, heading: "h" },
      { id: "b2", type: "text", visible: false, body: "t" },
    ];
    expect(blocksArraySchema.safeParse(arr).success).toBe(true);
  });

  it("BLOCK_TYPES には play を含む 11 種が含まれる", () => {
    expect(BLOCK_TYPES).toContain("hero");
    expect(BLOCK_TYPES).toContain("text");
    expect(BLOCK_TYPES).toContain("image");
    expect(BLOCK_TYPES).toContain("play");
    expect(BLOCK_TYPES.length).toBe(11);
  });
});
