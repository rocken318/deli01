import { env } from "@/lib/env";
import type { SessionProvider } from "./session";

/**
 * Supabase Auth 実装のスケルトン（管理側のみ / spec 1-2）。
 * live 配線は後続（発注者の Supabase Auth 設定が前提 = 停止条件②に依存）。
 * env 未設定時は「常に未ログイン」として振る舞い、ビルド・開発を壊さない。
 *
 * TODO(live 配線):
 *   1. @supabase/ssr を依存に追加し、cookie ベースの server client を作る
 *   2. supabase.auth.getUser() で auth.users.id を取得
 *   3. app_users を auth_user_id で引き（is_active = true のみ）、
 *      { userId: app_users.id, role, therapistId } に写像して返す
 *   4. 紐付きが無い auth ユーザーは null（サインアップ ≠ 利用許可。
 *      app_users への登録は owner/admin が行う）
 */
export function createSupabaseSessionProvider(): SessionProvider {
  const configured =
    env.supabaseUrl !== undefined && env.supabaseAnonKey !== undefined;
  return {
    async getSession() {
      if (!configured) {
        // Supabase 未設定（ローカル開発・CI）。スタブ側を使うこと
        return null;
      }
      // TODO(live 配線): 上記手順を実装するまで常に未ログイン
      return null;
    },
  };
}
