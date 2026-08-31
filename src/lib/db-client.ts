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
/** 直近に getClient() を使った時刻（ms）。長いアイドル＝凍結の疑い＝接続を張り直す。 */
let _lastAccess = 0;

/**
 * アイドルがこの時間を超えていたら、前のプールは freeze/thaw で死んでいる可能性が
 * 高いので破棄して張り直す。毎リクエスト全新規のチャーンは避けつつ、cold な
 * サーバレスインスタンスでは stale ソケットを掴まない（本命の cold ハング対策）。
 */
const STALE_AFTER_MS = 10_000;

function createClient(): ReturnType<typeof postgres> {
  // サーバレス×Supabaseプーラー(transaction/6543)向け。max は控えめ、接続確立は fail-fast。
  return postgres(env.databaseUrl(), {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });
}

export function getClient(): ReturnType<typeof postgres> {
  const now = Date.now();
  if (_client && now - _lastAccess > STALE_AFTER_MS) {
    // 前回から間が空いた＝凍結の疑い。古いプールを破棄して張り直す。
    const old = _client;
    _client = undefined;
    void old.end({ timeout: 1 }).catch(() => {});
  }
  _lastAccess = now;
  if (!_client) {
    _client = createClient();
  }
  return _client;
}

/**
 * 現在のクライアント（プール）を破棄する。サーバレスの freeze/thaw で接続が
 * 死んでクエリが無限待ちになったとき、呼び出し側がタイムアウト検知して本関数で
 * リセットする→次回の getClient() が新しい接続を張り直す（自己回復）。
 */
export function resetClient(): void {
  const c = _client;
  _client = undefined;
  if (c) void c.end({ timeout: 1 }).catch(() => {});
}
