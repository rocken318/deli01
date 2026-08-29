import { describe, expect, it } from "vitest";
import {
  buildDispatchMessage,
  interpolate,
  formatDispatchDateTime,
  formatTimeHM,
  formatYen,
  optionBackYen,
} from "./index";

/**
 * フェーズ13 送信テキストの最低限テスト（網羅は qa が spec 15章で担当）。
 * - 受入 L1108: 打診用に住所と電話番号が含まれない（構造的除去）
 * - 受入 L1109: 未定義の変数で落ちない
 */
describe("buildDispatchMessage", () => {
  it("inquiry はテンプレに個人情報トークンが混入していても出力に出ない", () => {
    const template =
      "【打診】{{日時}} {{コース}} バック{{バック額}} 場所:{{場所}} 電話:{{電話番号}} 客:{{顧客名}}";
    const out = buildDispatchMessage({
      kind: "inquiry",
      template,
      vars: {
        日時: "9/3(水) 13:00",
        コース: "60分",
        バック額: "¥6,000",
        場所: "渋谷区〇〇 1-2-3",
        電話番号: "09011111111",
        顧客名: "鈴木",
      },
    });
    expect(out).not.toContain("渋谷区〇〇");
    expect(out).not.toContain("09011111111");
    expect(out).not.toContain("鈴木");
    expect(out).toContain("9/3(水) 13:00");
    expect(out).toContain("¥6,000");
  });

  it("confirmed は全キーが埋まる", () => {
    const out = buildDispatchMessage({
      kind: "confirmed",
      template: "{{顧客名}}様 {{場所}} {{部屋番号}} {{電話番号}} {{合計金額}}",
      vars: {
        顧客名: "鈴木",
        場所: "渋谷区〇〇 1-2-3",
        部屋番号: "1203",
        電話番号: "09011111111",
        合計金額: "¥12,000",
      },
    });
    expect(out).toBe("鈴木様 渋谷区〇〇 1-2-3 1203 09011111111 ¥12,000");
  });

  it("未定義の変数・未知のトークンでも throw せず空文字になる（受入 L1109）", () => {
    const out = buildDispatchMessage({
      kind: "confirmed",
      template: "A{{日時}}B{{存在しないキー}}C{{お好み}}D",
      vars: { 日時: "X" },
    });
    expect(out).toBe("AXBCD");
  });
});

describe("interpolate", () => {
  it("トークン内の前後空白を許容する", () => {
    expect(interpolate("{{ 日時 }}/{{日時}}", { 日時: "13:00" })).toBe(
      "13:00/13:00",
    );
  });
});

describe("format ヘルパ", () => {
  it("formatYen は整数円を ¥3桁区切りにし、小数は拒否する", () => {
    expect(formatYen(12000)).toBe("¥12,000");
    expect(formatYen(0)).toBe("¥0");
    expect(() => formatYen(100.5)).toThrow(RangeError);
  });

  it("日時と時刻は Asia/Tokyo で整形される", () => {
    const at = new Date("2026-09-02T04:00:00Z"); // JST 9/2(水) 13:00
    expect(formatDispatchDateTime(at)).toBe("9/2(水) 13:00");
    expect(formatTimeHM(at)).toBe("13:00");
  });

  it("optionBackYen は fixed=円 / rate=% 切り捨て", () => {
    expect(optionBackYen("fixed", 1000, 3000)).toBe(1000);
    expect(optionBackYen("rate", 30, 2500)).toBe(750);
    expect(optionBackYen("rate", 33, 1000)).toBe(330);
  });
});
