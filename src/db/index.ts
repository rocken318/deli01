import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * サーバー専用の DB クライアント（spec 1-2: クライアントから直接 DB を触らない）。
 * postgres.js + Drizzle。全処理 Asia/Tokyo は date-fns-tz 側で担保する。
 * "server-only" でクライアントバンドルへの混入を仕組みで遮断する。
 * スクリプト（scripts/*.ts）は本モジュールを import せず postgres を直接使う。
 */
const client = postgres(env.DATABASE_URL, {
  max: 10,
  prepare: false,
  onnotice: () => {},
});

export const db = drizzle(client, { schema });
export { schema };
