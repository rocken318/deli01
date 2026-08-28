import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit は schema.ts からの差分生成に使う。
 * ただし PostGIS / exclusion / RLS は手書き SQL（migrations/*.sql）で管理し、
 * 適用は scripts/migrate.ts が行う（判断ログ #4）。
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01",
  },
});
