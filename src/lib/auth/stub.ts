import type { Session, SessionProvider } from "./session";

/**
 * 開発・テスト用のセッションスタブ。
 * 統合テストでは scripts/seed.ts が投入する各ロールのテストアカウントの
 * id / role を渡して使う。本番コードから参照しないこと。
 */
export function createStubSessionProvider(
  session: Session | null,
): SessionProvider {
  return {
    async getSession() {
      return session;
    },
  };
}
