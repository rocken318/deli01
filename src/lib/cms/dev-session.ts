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
  if (!env.adminDevSession) {
    return null;
  }
  // シードで投入した owner の id（scripts/seed.ts の appUsers 参照）
  return {
    userId: "aaaaaaaa-0000-4000-8000-000000000001",
    role: "owner",
  };
}
