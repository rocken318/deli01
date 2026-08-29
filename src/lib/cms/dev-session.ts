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
