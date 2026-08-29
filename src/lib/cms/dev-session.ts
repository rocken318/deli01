import "server-only";
import type { Session } from "@/lib/auth/session";
import { env } from "@/lib/env";

/**
 * 開発・デモ用のセッション取得（フェーズ2〜3）。
 *
 * 【暫定措置】live Supabase Auth 配線（フェーズ1後半〜）までの間、
 * 環境変数 ADMIN_DEV_SESSION=1 が設定されている場合のみシードの owner を返す。
 * 未設定（本番・プレビュー）では null を返し、全アクション・ページは 403 相当になる。
 *
 * TODO(live 配線フェーズ): src/lib/auth/index.ts の getDefaultSessionProvider() に差し替える。
 * 本番環境では ADMIN_DEV_SESSION を絶対に設定しないこと。
 */
export async function getDevSession(): Promise<Session | null> {
  // 厳格化: 明示的に "1" のときだけ有効。"0"・"false"・"true" 等の曖昧値では
  // 有効化しない（本番で誤って任意の非空値を設定しても発火しないよう安全側）。
  if (env.adminDevSession !== "1") {
    return null;
  }
  // シードで投入した owner の id（scripts/seed.ts の appUsers 参照）
  return {
    userId: "aaaaaaaa-0000-4000-8000-000000000001",
    role: "owner",
  };
}

/**
 * 開発専用: セラピスト本人セッションを解決するヘルパ（マイページ用）。
 *
 * ADMIN_DEV_SESSION=1 のときのみ有効。本番では必ず null。
 * slug が指定されれば app_users.therapist_id ↔ therapists.slug で解決する。
 * slug 省略時は therapist_id が紐付いた最初の therapist ロール app_user を返す。
 *
 * 前提: seed の therapist_id 紐付け（aoi/ren）が完了していること。
 *
 * TODO(live Auth): src/lib/auth/ の live SessionProvider に差し替える。
 * 本番環境では ADMIN_DEV_SESSION を絶対に設定しないこと。
 */
export async function getTherapistDevSession(
  slug?: string,
): Promise<Session | null> {
  if (env.adminDevSession !== "1") {
    return null;
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
