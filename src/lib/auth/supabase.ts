import { env } from "@/lib/env";
import { getClient } from "@/lib/db-client";
import type { SessionProvider } from "./session";
import { resolveAppUserSession } from "./resolve-session";

/**
 * Supabase Auth 実装（管理側 / spec 1-2）。
 * env 未設定時は「常に未ログイン」として振る舞い、ビルド・開発を壊さない。
 *
 * 手順:
 *   1. cookie ベース server client を作り supabase.auth.getUser()
 *   2. app_users を auth_user_id で引き（is_active=true）Session に写す
 *   3. 紐付きが無い auth ユーザーは null（サインアップ ≠ 利用許可）
 */
export function createSupabaseSessionProvider(): SessionProvider {
  const configured =
    env.supabaseUrl !== undefined && env.supabaseAnonKey !== undefined;
  return {
    async getSession() {
      if (!configured) return null;
      const { createSupabaseServerClient } = await import(
        "./supabase-server-client"
      );
      const supabase = await createSupabaseServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      return resolveAppUserSession(getClient(), user.id);
    },
  };
}
