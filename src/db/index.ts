import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * サーバー専用の DB クライアント（spec: クライアントから直接 DB を触らない）。
 * postgres.js + Drizzle。全処理 Asia/Tokyo は date-fns-tz 側で担保する。
 * import 制約は Server Action / route 層で担保する（scripts からも利用するため
 * ここでは "server-only" を付けない）。
 */
const client = postgres(env.DATABASE_URL, {
  max: 10,
  prepare: false,
});

export const db = drizzle(client, { schema });
export { schema };
