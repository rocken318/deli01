/**
 * buildZodSchema ユニットテスト（spec 3-1 / CLAUDE.md: Zod スキーマを実行時に組み立て）。
 * DB 不要の純粋関数テスト。
 */

import { describe, expect, it } from "vitest";
import { buildZodSchema } from "./build-zod-schema";
import type { FieldDefinition, FieldType } from "./types";

/** テスト用FieldDefinitionファクトリ */
function makeDef(overrides: Partial<FieldDefinition> & { key: string; type: FieldType }): FieldDefinition {
  return {
    id: "test-id",
    entity: "therapist",
    label: overrides.key,
    options: null,
    groupLabel: null,
    sortOrder: 0,
    isPublic: false,
    isRequired: true,
    isFilterable: false,
    helpText: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("buildZodSchema: text 系", () => {
  it("text は string を返す", () => {
    const schema = buildZodSchema([makeDef({ key: "name", type: "text" })]);
    expect(schema.parse({ name: "テスト" })).toEqual({ name: "テスト" });
  });

  it("textarea は string を返す", () => {
    const schema = buildZodSchema([makeDef({ key: "bio", type: "textarea" })]);
    expect(schema.parse({ bio: "自己紹介" })).toEqual({ bio: "自己紹介" });
  });

  it("rich_text は string を返す", () => {
    const schema = buildZodSchema([makeDef({ key: "body", type: "rich_text" })]);
    expect(schema.parse({ body: "<p>本文</p>" })).toEqual({ body: "<p>本文</p>" });
  });

  it("text はトリムされる", () => {
    const schema = buildZodSchema([makeDef({ key: "name", type: "text" })]);
    expect(schema.parse({ name: "  テスト  " })).toEqual({ name: "テスト" });
  });
});

describe("buildZodSchema: number / money（整数のみ）", () => {
  it("number は整数を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "years", type: "number" })]);
    expect(schema.parse({ years: 5 })).toEqual({ years: 5 });
  });

  it("number は小数を拒否する（spec 禁止: 金額に小数を使わない）", () => {
    const schema = buildZodSchema([makeDef({ key: "years", type: "number" })]);
    expect(() => schema.parse({ years: 1.5 })).toThrow();
  });

  it("money は整数を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "price", type: "money" })]);
    expect(schema.parse({ price: 6000 })).toEqual({ price: 6000 });
  });

  it("money は小数を拒否する（spec 禁止）", () => {
    const schema = buildZodSchema([makeDef({ key: "price", type: "money" })]);
    expect(() => schema.parse({ price: 6000.5 })).toThrow();
  });

  it("money は負の値を拒否する", () => {
    const schema = buildZodSchema([makeDef({ key: "price", type: "money" })]);
    expect(() => schema.parse({ price: -1 })).toThrow();
  });

  it("money は 0 を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "price", type: "money" })]);
    expect(schema.parse({ price: 0 })).toEqual({ price: 0 });
  });
});

describe("buildZodSchema: boolean", () => {
  it("boolean は true/false を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "active", type: "boolean" })]);
    expect(schema.parse({ active: true })).toEqual({ active: true });
    expect(schema.parse({ active: false })).toEqual({ active: false });
  });

  it("boolean は文字列を拒否する", () => {
    const schema = buildZodSchema([makeDef({ key: "active", type: "boolean" })]);
    expect(() => schema.parse({ active: "true" })).toThrow();
  });
});

describe("buildZodSchema: select（enum）", () => {
  it("select は choices の値を受け付ける", () => {
    const schema = buildZodSchema([
      makeDef({
        key: "skill",
        type: "select",
        options: { choices: ["オイル", "指圧", "リンパ"] },
      }),
    ]);
    expect(schema.parse({ skill: "オイル" })).toEqual({ skill: "オイル" });
  });

  it("select は choices にない値を拒否する", () => {
    const schema = buildZodSchema([
      makeDef({
        key: "skill",
        type: "select",
        options: { choices: ["オイル", "指圧"] },
      }),
    ]);
    expect(() => schema.parse({ skill: "ヨガ" })).toThrow();
  });

  it("select で choices が空なら string として受け付ける", () => {
    const schema = buildZodSchema([
      makeDef({ key: "skill", type: "select", options: null }),
    ]);
    expect(schema.parse({ skill: "任意の値" })).toEqual({ skill: "任意の値" });
  });
});

describe("buildZodSchema: multi_select / tag", () => {
  it("multi_select は string[] を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "tags", type: "multi_select" })]);
    expect(schema.parse({ tags: ["オイル", "指圧"] })).toEqual({
      tags: ["オイル", "指圧"],
    });
  });

  it("multi_select は空配列を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "tags", type: "multi_select" })]);
    expect(schema.parse({ tags: [] })).toEqual({ tags: [] });
  });

  it("tag は string[] を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "labels", type: "tag" })]);
    expect(schema.parse({ labels: ["A", "B"] })).toEqual({ labels: ["A", "B"] });
  });
});

describe("buildZodSchema: date", () => {
  it("date は YYYY-MM-DD 形式を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "birthday", type: "date" })]);
    expect(schema.parse({ birthday: "1990-01-15" })).toEqual({
      birthday: "1990-01-15",
    });
  });

  it("date は不正な形式を拒否する", () => {
    const schema = buildZodSchema([makeDef({ key: "birthday", type: "date" })]);
    expect(() => schema.parse({ birthday: "1990/01/15" })).toThrow();
    expect(() => schema.parse({ birthday: "2026-1-1" })).toThrow();
  });
});

describe("buildZodSchema: url", () => {
  it("url は有効なURLを受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "website", type: "url" })]);
    expect(schema.parse({ website: "https://example.com" })).toEqual({
      website: "https://example.com",
    });
  });

  it("url は無効なURLを拒否する", () => {
    const schema = buildZodSchema([makeDef({ key: "website", type: "url" })]);
    expect(() => schema.parse({ website: "not-a-url" })).toThrow();
  });
});

describe("buildZodSchema: image / image_gallery（後続フェーズ・緩め）", () => {
  it("image は string を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "photo", type: "image" })]);
    expect(schema.parse({ photo: "some-media-id" })).toEqual({
      photo: "some-media-id",
    });
  });

  it("image_gallery は string[] を受け付ける", () => {
    const schema = buildZodSchema([makeDef({ key: "gallery", type: "image_gallery" })]);
    expect(schema.parse({ gallery: ["id-1", "id-2"] })).toEqual({
      gallery: ["id-1", "id-2"],
    });
  });
});

describe("buildZodSchema: isRequired", () => {
  it("isRequired=true は undefined を拒否する", () => {
    const schema = buildZodSchema([
      makeDef({ key: "name", type: "text", isRequired: true }),
    ]);
    expect(() => schema.parse({ name: undefined })).toThrow();
  });

  it("isRequired=false は undefined を受け付ける（optional）", () => {
    const schema = buildZodSchema([
      makeDef({ key: "nickname", type: "text", isRequired: false }),
    ]);
    expect(schema.parse({ nickname: undefined })).toEqual({
      nickname: undefined,
    });
  });

  it("isRequired=false でも値があれば検証される", () => {
    const schema = buildZodSchema([
      makeDef({
        key: "skill",
        type: "select",
        isRequired: false,
        options: { choices: ["A", "B"] },
      }),
    ]);
    expect(() => schema.parse({ skill: "C" })).toThrow();
  });
});

describe("buildZodSchema: deletedAt（論理削除）", () => {
  it("deletedAt が設定された定義はスキーマから除外される", () => {
    const schema = buildZodSchema([
      makeDef({ key: "name", type: "text" }),
      makeDef({ key: "deleted_field", type: "text", deletedAt: new Date() }),
    ]);
    const result = schema.parse({ name: "テスト", deleted_field: "値" });
    // deleted_field は除外されているので shape に含まれない
    expect("name" in schema.shape).toBe(true);
    expect("deleted_field" in schema.shape).toBe(false);
    expect(result).toEqual({ name: "テスト" });
  });
});

describe("buildZodSchema: 複数フィールド", () => {
  it("複数フィールドを一度に組み立てられる", () => {
    const schema = buildZodSchema([
      makeDef({ key: "name", type: "text" }),
      makeDef({ key: "price", type: "money" }),
      makeDef({ key: "active", type: "boolean", isRequired: false }),
    ]);
    expect(
      schema.parse({ name: "テスト", price: 5000, active: true }),
    ).toEqual({ name: "テスト", price: 5000, active: true });
  });
});

describe("buildZodSchema: 空の配列", () => {
  it("定義が空なら空オブジェクトスキーマを返す", () => {
    const schema = buildZodSchema([]);
    expect(schema.parse({})).toEqual({});
  });
});
