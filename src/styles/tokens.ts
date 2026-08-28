/**
 * デザイントークン（spec 12章）— 全画面で参照する単一の出典。
 * 公開側と管理側で性格が違うので分けて持つ。値をここ以外に直書きしない。
 */

/** 公開ページ（暗い画面が既定 / spec 12-1） */
export const publicTokens = {
  color: {
    bg: "#151A20", // 背景
    surface: "#1E252D", // 面
    text: "#EDE9E2", // 文字
    subtext: "#9BA5AF", // 副文字
    primary: "#C6A15B", // 主色（予約ボタン・空き枠）落ち着いた金
    accent: "#5E9E86", // 補助
    border: "#2C343D", // 罫線
  },
  font: {
    heading: '"Shippori Mincho B1", serif', // 見出し（明朝）
    body: '"Noto Sans JP", sans-serif', // 本文
    mono: '"IBM Plex Mono", monospace', // 時刻・金額（等幅）
  },
} as const;

/** 管理画面（視認性と密度優先 / spec 12-2） */
export const adminTokens = {
  color: {
    bg: "#F6F7F5", // 背景
    surface: "#FFFFFF", // 面
    text: "#1C2321", // 文字
    primary: "#3F7A6B", // 主色
    travel: "#B9C2BD", // 移動時間ブロック（施術ブロックと区別）
    caution: "#C98A2B", // 注意
    danger: "#B4453C", // 警告・遅延
    border: "#DFE3DE", // 罫線
  },
  radiusMax: 4, // 角丸は4pxまで
} as const;

export type PublicTokens = typeof publicTokens;
export type AdminTokens = typeof adminTokens;
