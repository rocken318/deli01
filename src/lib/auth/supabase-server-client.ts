import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { env } from "@/lib/env";

/**
 * Server Component / Server Action / Route Handler 用の Supabase client。
 * @supabase/ssr の cookie アダプタで auth セッションを cookie に永続化する。
 * Server Component は cookie を書けないため setAll は try/catch で握る
 * （トークン更新は middleware が担当する）。
 * env 未設定時は呼び出し側が事前にガードする前提（ここでは分かりやすく落とす）。
 */
export async function createSupabaseServerClient() {
  const url = env.supabaseUrl;
  const anon = env.supabaseAnonKey;
  if (!url || !anon) {
    throw new Error("Supabase 認証が未設定です（URL / anon key）。");
  }
  const cookieStore = await cookies();
  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component からの呼び出し（cookie 書込不可）。middleware が更新する。
        }
      },
    },
  });
}
