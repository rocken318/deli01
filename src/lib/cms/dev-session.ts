import "server-only";
import type { Session } from "@/lib/auth/session";
import { getDefaultSessionProvider } from "@/lib/auth";
import { env } from "@/lib/env";

/**
 * セッション取得。名前は互換のため据え置くが、挙動は二段:
 * - ADMIN_DEV_SESSION=1（ローカル/CI）: シードの owner を返す（従来のスタブ）。
 * - それ以外（本番）: Supabase Auth（getDefaultSessionProvider）。未ログイン/未紐付けは null。
 *
 * 本番では ADMIN_DEV_SESSION を絶対に設定しないこと（設定すると認証を素通りする）。
 */
export async function getDevSession(): Promise<Session | null> {
  if (env.adminDevSession === "1") {
    // シードで投入した owner の id（scripts/seed.ts の appUsers 参照）
    return {
      userId: "aaaaaaaa-0000-4000-8000-000000000001",
      role: "owner",
    };
  }
  return getDefaultSessionProvider().getSession();
}

/**
 * セラピスト本人セッション（マイページ用）。
 * - ADMIN_DEV_SESSION=1: ?as=<slug> のなりすまし解決（dev 専用）。
 * - 本番: ログイン中ユーザーが therapist ロールなら自分自身。slug は無視。
 */
export async function getTherapistDevSession(
  slug?: string,
): Promise<Session | null> {
  if (env.adminDevSession !== "1") {
    const session = await getDefaultSessionProvider().getSession();
    return session?.role === "therapist" ? session : null;
  }

  const { getClient } = await import("@/lib/db-client");
  const sql = getClient();

  type Row = { user_id: string; therapist_id: string };
  const rows: Row[] = slug
    ? await sql<Row[]>`
        select au.id as user_id, au.therapist_id
        from app_users au
        join therapists t on t.id = au.therapist_id
        where au.role = 'therapist'
          and t.slug = ${slug}
          and au.is_active = true
        limit 1
      `
    : await sql<Row[]>`
        select au.id as user_id, au.therapist_id
        from app_users au
        where au.role = 'therapist'
          and au.therapist_id is not null
          and au.is_active = true
        order by au.created_at
        limit 1
      `;

  const row = rows[0];
  if (!row) return null;

  return {
    userId: row.user_id,
    role: "therapist",
    therapistId: row.therapist_id,
  };
}
