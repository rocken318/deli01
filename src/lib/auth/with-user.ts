import type { Sql, TransactionSql } from "postgres";
import type { Session } from "./session";

/**
 * RLS とセッションを結びつけるヘルパ（migrations/0001_auth.sql の設計ノート参照）。
 *
 * トランザクションを開き、
 *   1. set_config('app.current_user_id', ..., true)  -- 誰が
 *   2. set_config('app.current_role',    ..., true)  -- どのロールで
 *   3. set_config('role', 'app_runtime', true)       -- 特権のない DB ロールに降格
 * を張ってから fn を実行する。set_config(..., true) = SET LOCAL 相当なので、
 * トランザクションを抜ければ（commit/rollback とも）自動で元に戻る。
 *
 * app_runtime へ降格することで、接続ユーザーが superuser / テーブル owner でも
 * RLS ポリシーが必ず適用される。業務クエリは必ずこのヘルパ経由で流すこと。
 * 逆に migrate / seed などの保守経路はこれを使わず特権のまま流してよい。
 */

/** withUser() が降格する実行用 DB ロール（0001_auth.sql で作成） */
export const RUNTIME_DB_ROLE = "app_runtime";

export async function withUser<T>(
  sql: Sql,
  session: Session,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    // 1文で3つとも設定する（ロール降格後も app.* GUC は設定可能だが、順序事故を避ける）
    await tx`
      select
        set_config('app.current_user_id', ${session.userId}, true),
        set_config('app.current_role', ${session.role}, true),
        set_config('role', ${RUNTIME_DB_ROLE}, true)
    `;
    return fn(tx);
  });
  return result as T;
}
