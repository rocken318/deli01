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
      // - max: 1 ＝サーバレスの1リクエストを単一接続に直列化する。並列クエリで複数
      //   接続を掴むと、プール内の stale 接続（凍結インスタンスで死んだソケット）を
      //   引いてページごとハングする事故があった（/api/health=単一クエリは動くのに
      //   トップ=並列は詰まる）。単一接続なら health と同じ健全な経路を使い回せる。
      // - idle_timeout/max_lifetime で古い接続を早く破棄→再接続（stale を掴まない）
      // - connect_timeout で接続確立が詰まったら fail-fast
      // ★接続を短命化し、凍結後に死んだソケットを再利用しないようにする（本命の是正）。
      //   サーバレスは freeze/thaw で接続が死ぬが max_lifetime が長いと古い接続を
      //   使い回してソケット無限待ち→300秒ハングになる。短命なら acquire 時に破棄→再接続。
      // 注: statement_timeout は transaction プーラーがセッション毎にリセットするため
      //   クライアント指定は効かない（プーラー既定 2min）。
      max: 1,
      idle_timeout: 5,
      max_lifetime: 30,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => {},
    });
  }
  return _client;
}
