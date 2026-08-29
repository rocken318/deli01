import type { Actor, Role } from "@/domain/auth";

/**
 * アプリのセッション（フェーズ1）。
 * 認証プロバイダ（Supabase Auth / 管理側のみ）の live 配線は後回しにし、
 * SessionProvider インターフェースに抽象化する。
 * - 本番: supabase.ts（スケルトン。env 未設定時は無効）
 * - 開発/テスト: stub.ts
 */
export interface Session {
  /** app_users.id（auth.users.id ではない） */
  userId: string;
  role: Role;
  /** role === 'therapist' のときのみ。app_users.therapist_id */
  therapistId?: string;
}

/** ドメイン層 can() に渡す形へ写す */
export function toActor(session: Session): Actor {
  return { role: session.role, therapistId: session.therapistId };
}

export interface SessionProvider {
  /** 未ログイン・無効ユーザーなら null */
  getSession(): Promise<Session | null>;
}
