import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit は schema.ts からの SQL 生成の「補助」に使う（出力は drizzle/generated/）。
 * 適用の正は手書き SQL（migrations/*.sql）+ scripts/migrate.ts（判断ログ #4）。
 * 生成物と手書きマイグレーションを別ディレクトリに分け、独自ランナーが生成物を
 * 誤って適用しないようにする。生成物は人手で curate して migrations/ に取り込む。
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/generated",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01",
  },
});
