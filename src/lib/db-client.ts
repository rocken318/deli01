import "server-only";
import postgres from "postgres";
import { env } from "@/lib/env";

/**
 * postgres.js の生クライアント（withUser() が必要とする Sql 型）。
 * getDb()（Drizzle）とは別に保持する。
 *
 * withUser() は postgres.js の sql.begin() を使うため、Drizzle ではなく
 * postgres.js の Sql インスタンスが必要。
 */
let _client: ReturnType<typeof postgres> | undefined;

export function getClient(): ReturnType<typeof postgres> {
  if (!_client) {
    _client = postgres(env.databaseUrl(), {
      max: 10,
      prepare: false,
      onnotice: () => {},
    });
  }
  return _client;
}
