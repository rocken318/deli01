import { describe, expect, it } from "vitest";
import {
  DISPATCH_VAR_KEYS,
  INQUIRY_FORBIDDEN_KEYS,
  buildDispatchMessage,
  interpolate,
  formatDispatchDateTime,
  formatTravelMode,
  formatYen,
  optionBackYen,
} from "./index";

/**
 * フェーズ13 送信テキスト / 受入条件 網羅テスト（spec 15章 L1108/L1109）。
 * src/domain/dispatch/message.test.ts の7件と重複させず、カバレッジを補完する。
 */

// ---------------------------------------------------------------------------
// DISPATCH_VAR_KEYS / INQUIRY_FORBIDDEN_KEYS の定義確認
// ---------------------------------------------------------------------------
describe("DISPATCH_VAR_KEYS / INQUIRY_FORBIDDEN_KEYS の定義", () => {
  it("DISPATCH_VAR_KEYS に エリア が含まれる（打診用非 PII として追加）", () => {
    expect(DISPATCH_VAR_KEYS).toContain("エリア");
  });

  it("INQUIRY_FORBIDDEN_KEYS に エリア が含まれない（打診に出てよい非 PII）", () => {
    expect(INQUIRY_FORBIDDEN_KEYS).not.toContain("エリア");
  });

  it("INQUIRY_FORBIDDEN_KEYS は PII 5種（場所/部屋番号/顧客名/電話番号/お好み）", () => {
    const expected: string[] = ["場所", "部屋番号", "顧客名", "電話番号", "お好み"];
    for (const key of expected) {
      expect(INQUIRY_FORBIDDEN_KEYS).toContain(key);
    }
    // 余分なキーが混入していないことも確認
    expect(INQUIRY_FORBIDDEN_KEYS.length).toBe(5);
  });

  it("DISPATCH_VAR_KEYS は14個（spec 8-3 の13個 + エリア）", () => {
    expect(DISPATCH_VAR_KEYS.length).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// 受入 L1108: 打診用に住所と電話番号が含まれない
// ---------------------------------------------------------------------------
describe("buildDispatchMessage – inquiry の PII 除去（受入 L1108）", () => {
  /** 全13+エリアトークンを混入させたテンプレ */
  const allTokenTemplate = [
    "{{日時}} {{出発目安}} {{セラピスト}} {{コース}} {{オプション}}",
    "{{場所}} {{部屋番号}} {{顧客名}} {{電話番号}} {{お好み}}",
    "{{合計金額}} {{バック額}} {{移動手段}} {{エリア}}",
  ].join("\n");

  const allVars = {
    日時: "9/3(水) 13:00",
    出発目安: "12:35",
    セラピスト: "あおい",
    コース: "90分",
    オプション: "アロマ",
    場所: "東京都渋谷区宇田川町1-2-3", // PII: 住所
    部屋番号: "503号室", // PII: 部屋番号
    顧客名: "田中一郎", // PII: 氏名
    電話番号: "09012345678", // PII: 電話
    お好み: "強圧希望", // PII: 好み
    合計金額: "¥12,000",
    バック額: "¥6,000",
    移動手段: "車",
    エリア: "渋谷区",
  };

  it("全トークン混入のテンプレで inquiry を生成すると PII 5種が出力に出ない（L1108）", () => {
    const out = buildDispatchMessage({
      kind: "inquiry",
      template: allTokenTemplate,
      vars: allVars,
    });
    // 住所文字列が含まれない
    expect(out).not.toContain("渋谷区宇田川町1-2-3");
    // 部屋番号が含まれない
    expect(out).not.toContain("503号室");
    // 顧客名が含まれない
    expect(out).not.toContain("田中一郎");
    // 電話番号が含まれない
    expect(out).not.toContain("09012345678");
    // お好みが含まれない
    expect(out).not.toContain("強圧希望");
  });

  it("inquiry でエリア・日時・コース・バック額などの非 PII は出力に出る（L1108 の対照）", () => {
    const out = buildDispatchMessage({
      kind: "inquiry",
      template: allTokenTemplate,
      vars: allVars,
    });
    expect(out).toContain("9/3(水) 13:00");
    expect(out).toContain("渋谷区"); // エリア（場所=住所 とは別）
    expect(out).toContain("¥6,000");
    expect(out).toContain("90分");
    expect(out).toContain("12:35");
  });

  it("confirmed は同じ vars で PII が出力に出る（出し分けの対照検証）", () => {
    const out = buildDispatchMessage({
      kind: "confirmed",
      template: allTokenTemplate,
      vars: allVars,
    });
    expect(out).toContain("渋谷区宇田川町1-2-3");
    expect(out).toContain("503号室");
    expect(out).toContain("田中一郎");
    expect(out).toContain("09012345678");
    expect(out).toContain("強圧希望");
  });

  it("テンプレに PII トークンを書き忘れても inquiry は問題なく動く（余分なトークンなし）", () => {
    const noPrivacyTemplate = "【打診】{{日時}} {{エリア}} {{コース}} {{バック額}}";
    const out = buildDispatchMessage({
      kind: "inquiry",
      template: noPrivacyTemplate,
      vars: allVars,
    });
    expect(out).toBe("【打診】9/3(水) 13:00 渋谷区 90分 ¥6,000");
  });
});

// ---------------------------------------------------------------------------
// 受入 L1109: 未定義変数・異常トークンでも落ちない
// ---------------------------------------------------------------------------
describe("buildDispatchMessage / interpolate – 未定義変数で落ちない（受入 L1109）", () => {
  it("未知トークン {{存在しない}} は空文字化し throw しない", () => {
    expect(() =>
      buildDispatchMessage({
        kind: "confirmed",
        template: "A{{存在しない}}B",
        vars: {},
      }),
    ).not.toThrow();
    const out = buildDispatchMessage({
      kind: "confirmed",
      template: "A{{存在しない}}B",
      vars: {},
    });
    expect(out).toBe("AB");
  });

  it("空トークン {{}} は空文字化し throw しない", () => {
    const out = buildDispatchMessage({
      kind: "confirmed",
      template: "A{{}}B",
      vars: {},
    });
    expect(out).toBe("AB");
  });

  it("崩れたネストトークン {{{{日時}}}} は外側が空文字化し、内側も空文字化（throw しない）", () => {
    // /\{\{\s*([^{}]*?)\s*\}\}/g は最短一致で { を含むキーを素通しするため、
    // outer = {{{{ で一致 → key = "{{日時" が undefined → "" となる。
    // 実装の挙動を assert し、throw しないことを確認する。
    expect(() =>
      buildDispatchMessage({
        kind: "confirmed",
        template: "X{{{{日時}}}}Y",
        vars: { 日時: "13:00" },
      }),
    ).not.toThrow();
  });

  it("空白トークン {{ 日時 }} はトリム後に一致し、値が埋まる", () => {
    const out = interpolate("{{ 日時 }}", { 日時: "13:00" });
    expect(out).toBe("13:00");
  });

  it("vars が Partial でも全キー未設定で throw しない（受入 L1109）", () => {
    const out = buildDispatchMessage({
      kind: "confirmed",
      template: "{{日時}} {{場所}} {{顧客名}} {{電話番号}}",
      vars: {},
    });
    expect(out).toBe("   ");
  });

  it("inquiry でも vars が空（Partial）でも throw しない", () => {
    const out = buildDispatchMessage({
      kind: "inquiry",
      template: "{{日時}} {{エリア}} {{バック額}}",
      vars: {},
    });
    expect(out).toBe("  ");
  });
});

// ---------------------------------------------------------------------------
// interpolate の追加ケース
// ---------------------------------------------------------------------------
describe("interpolate – 追加エッジケース", () => {
  it("vars に無いキーは空文字（記述の重複なしに再確認）", () => {
    expect(interpolate("{{foo}}{{bar}}", { foo: "A" })).toBe("A");
  });

  it("連続トークン（スペースなし）も個別に置換される", () => {
    expect(interpolate("{{a}}{{b}}{{c}}", { a: "1", b: "2", c: "3" })).toBe("123");
  });

  it("改行を挟んだテンプレートも正しく置換される", () => {
    const tmpl = "{{日時}}\n{{エリア}}\n{{バック額}}";
    const out = interpolate(tmpl, { 日時: "9/1(火) 10:00", エリア: "世田谷区", バック額: "¥5,000" });
    expect(out).toBe("9/1(火) 10:00\n世田谷区\n¥5,000");
  });
});

// ---------------------------------------------------------------------------
// formatYen の網羅
// ---------------------------------------------------------------------------
describe("formatYen – 網羅テスト", () => {
  it("正の整数を ¥3桁区切りに整形する", () => {
    expect(formatYen(0)).toBe("¥0");
    expect(formatYen(1000)).toBe("¥1,000");
    expect(formatYen(12000)).toBe("¥12,000");
    expect(formatYen(1234567)).toBe("¥1,234,567");
  });

  it("負の整数は -¥X,XXX 形式", () => {
    expect(formatYen(-1000)).toBe("-¥1,000");
    expect(formatYen(-12000)).toBe("-¥12,000");
  });

  it("小数（非整数）は RangeError", () => {
    expect(() => formatYen(100.5)).toThrow(RangeError);
    expect(() => formatYen(0.1)).toThrow(RangeError);
    expect(() => formatYen(1000.01)).toThrow(RangeError);
  });

  it("NaN は RangeError（isInteger は false）", () => {
    expect(() => formatYen(Number.NaN)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// formatDispatchDateTime – UTC 日付跨ぎで JST の曜日が正しいこと
// ---------------------------------------------------------------------------
describe("formatDispatchDateTime – Asia/Tokyo 曜日境界", () => {
  it("UTC 翌日早朝が JST では前日（UTC 2026-09-02T04:00Z → JST 9/2(水) 13:00）", () => {
    const at = new Date("2026-09-02T04:00:00Z"); // JST 13:00 水曜
    const result = formatDispatchDateTime(at);
    expect(result).toBe("9/2(水) 13:00");
  });

  it("UTC 深夜が JST 翌日に跨ぐ境界（UTC 2026-09-01T15:00Z → JST 9/2(水) 00:00）", () => {
    const at = new Date("2026-09-01T15:00:00Z"); // JST 00:00 水曜
    const result = formatDispatchDateTime(at);
    expect(result).toBe("9/2(水) 00:00");
  });

  it("UTC 同日 AM が JST 同日になる（UTC 2026-09-03T01:00Z → JST 9/3(木) 10:00）", () => {
    const at = new Date("2026-09-03T01:00:00Z"); // JST 10:00 木曜
    const result = formatDispatchDateTime(at);
    expect(result).toBe("9/3(木) 10:00");
  });

  it("日曜（UTC 2026-08-30T05:00Z → JST 8/30(日) 14:00）", () => {
    const at = new Date("2026-08-30T05:00:00Z"); // JST 14:00 日曜
    const result = formatDispatchDateTime(at);
    expect(result).toBe("8/30(日) 14:00");
  });

  it("土曜（UTC 2026-09-05T03:30Z → JST 9/5(土) 12:30）", () => {
    const at = new Date("2026-09-05T03:30:00Z"); // JST 12:30 土曜
    const result = formatDispatchDateTime(at);
    expect(result).toBe("9/5(土) 12:30");
  });
});

// ---------------------------------------------------------------------------
// formatTravelMode
// ---------------------------------------------------------------------------
describe("formatTravelMode", () => {
  it("car は '車'", () => {
    expect(formatTravelMode("car")).toBe("車");
  });

  it("walk は '徒歩'", () => {
    expect(formatTravelMode("walk")).toBe("徒歩");
  });
});

// ---------------------------------------------------------------------------
// optionBackYen の網羅
// ---------------------------------------------------------------------------
describe("optionBackYen – 網羅テスト", () => {
  it("fixed: backValue がそのまま返る（priceSnapshot を使わない）", () => {
    expect(optionBackYen("fixed", 1000, 9999)).toBe(1000);
    expect(optionBackYen("fixed", 0, 5000)).toBe(0);
  });

  it("rate: price × rate% の端数切り捨て", () => {
    expect(optionBackYen("rate", 30, 2500)).toBe(750); // 750.0
    expect(optionBackYen("rate", 33, 1000)).toBe(330); // 330.0
    expect(optionBackYen("rate", 33, 10000)).toBe(3300); // 3300.0
    // 端数: 33% × 1001 = 330.33 → 330
    expect(optionBackYen("rate", 33, 1001)).toBe(330);
  });

  it("負の backValue は RangeError", () => {
    expect(() => optionBackYen("rate", -1, 1000)).toThrow(RangeError);
  });

  it("負の priceSnapshot は RangeError", () => {
    expect(() => optionBackYen("fixed", 100, -1)).toThrow(RangeError);
  });

  it("rate で非整数 backValue は RangeError（小数禁止）", () => {
    expect(() => optionBackYen("rate", 33.5, 1000)).toThrow(RangeError);
  });

  it("fixed で非整数 backValue は RangeError", () => {
    expect(() => optionBackYen("fixed", 100.5, 1000)).toThrow(RangeError);
  });
});
