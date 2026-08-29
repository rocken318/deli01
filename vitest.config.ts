import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * .env をパースして test.env に渡す（ローカル: DATABASE_URL=5433 等）。
 * CI では .env が無く、DATABASE_URL は workflow の env: から process.env に入るので
 * それをそのまま使う。追加依存（vite/dotenv）を持ち込まないため自前パース。
 */
function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(".env")) return out;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export default defineConfig({
  resolve: {
    // tsconfig の paths（"@/*" → "./src/*"）と揃える
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // "server-only" は Next.js のビルド時専用ガード。
      // vitest（Node）では throw するため空モジュールに差し替える。
      // これで server-only を import している lib を統合テストから呼べる。
      "server-only": fileURLToPath(new URL("./tests/__mocks__/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    env: loadDotEnv(),
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // 統合テストは実 Postgres に対して行う（spec 15章）。同一DBを壊さないよう直列。
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
