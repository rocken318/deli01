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
      // サーバレス×Supabaseプーラー（transaction/6543）向けの接続設定。
      // 本番でトップ等の公開ページが 300 秒タイムアウトでハングした事故の是正:
      // - max を絞る（10→3）＝多数のサーバレスインスタンスでプーラー接続上限を超えない
      //   （枯渇すると新規リクエストが接続待ちで無限ハングする）
      // - idle_timeout/max_lifetime で使い終わった接続を早く返す（接続枯渇の緩和）
      // - connect_timeout で接続確立が詰まったら fail-fast
      // 注: statement_timeout は transaction プーラーがセッション毎にリセットするため
      //   クライアント指定は効かない（プーラー既定 2min が有効）。よって指定しない。
      max: 3,
      idle_timeout: 20,
      max_lifetime: 60 * 10,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => {},
    });
  }
  return _client;
}
