import "server-only";
import type { Session } from "@/lib/auth/session";

/**
 * 開発・デモ用のセッション取得（フェーズ2）。
 *
 * live Supabase 配線前は、シード（scripts/seed.ts）で投入した
 * owner テストアカウントのセッションを返す。
 *
 * TODO(live 配線フェーズ): src/lib/auth/index.ts の getDefaultSessionProvider() に差し替える。
 * それまでこのファイルをサーバーアクション内から参照する。
 * 本番環境では絶対に使わないこと（セッション管理は Supabase Auth に委ねる）。
 */
export async function getDevSession(): Promise<Session | null> {
  // シードで投入した owner の id（scripts/seed.ts の appUsers 参照）
  return {
    userId: "aaaaaaaa-0000-4000-8000-000000000001",
    role: "owner",
  };
}
