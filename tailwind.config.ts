import type { Config } from "tailwindcss";
import { publicTokens, adminTokens } from "./src/styles/tokens";

/**
 * デザイントークン（src/styles/tokens.ts）を Tailwind に流し込む。
 * 公開側は `pub-*`、管理側は `adm-*` 名前空間で参照する。
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        pub: {
          bg: publicTokens.color.bg,
          surface: publicTokens.color.surface,
          text: publicTokens.color.text,
          subtext: publicTokens.color.subtext,
          primary: publicTokens.color.primary,
          accent: publicTokens.color.accent,
          border: publicTokens.color.border,
        },
        adm: {
          bg: adminTokens.color.bg,
          surface: adminTokens.color.surface,
          text: adminTokens.color.text,
          primary: adminTokens.color.primary,
          travel: adminTokens.color.travel,
          caution: adminTokens.color.caution,
          danger: adminTokens.color.danger,
          border: adminTokens.color.border,
        },
      },
      fontFamily: {
        heading: [publicTokens.font.heading],
        body: [publicTokens.font.body],
        mono: [publicTokens.font.mono],
      },
    },
  },
  plugins: [],
};

export default config;
