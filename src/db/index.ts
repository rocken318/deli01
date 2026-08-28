import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * サーバー専用の DB クライアント（spec 1-2: クライアントから直接 DB を触らない）。
 * postgres.js + Drizzle。"server-only" でクライアントバンドルへの混入を遮断する。
 *
 * 遅延生成: `getDb()` を最初に呼んだ瞬間にだけ接続文字列を検証・クライアント生成する。
 * これにより `next build`（ページデータ収集で本モジュールが import される）が
 * DATABASE_URL 未設定でも壊れない。実接続は postgres.js の遅延（初回クエリ時）。
 * スクリプト（scripts/*.ts）は本モジュールを import せず postgres を直接使う。
 */
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (!_db) {
    const client = postgres(env.databaseUrl(), {
      max: 10,
      prepare: false,
      onnotice: () => {},
    });
    _db = drizzle(client, { schema });
  }
  return _db;
}

export { schema };
