import type { Sql } from "postgres";
import type { Role } from "@/domain/auth";
import type { Session } from "./session";

/**
 * Supabase auth.users.id を app_users の Session に写す純DB関数。
 * セッション成立前の写像なので withUser を通さず特権接続で引く
 * （接続ユーザーは BYPASSRLS。migrate/seed と同じ保守経路）。
 * is_active=true かつ紐付けのある行だけを返す。無ければ null
 * （サインアップ ≠ 利用許可。紐付けは owner/admin または bootstrap script が行う）。
 */
export async function resolveAppUserSession(
  sql: Sql,
  authUserId: string,
): Promise<Session | null> {
  const rows = await sql<
    { id: string; role: Role; therapist_id: string | null }[]
  >`
    select id, role, therapist_id
    from app_users
    where auth_user_id = ${authUserId} and is_active = true
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.id,
    role: row.role,
    therapistId: row.therapist_id ?? undefined,
  };
}
