import { env } from "@/lib/env";
import type { SessionProvider } from "./session";
import { createStubSessionProvider } from "./stub";
import { createSupabaseSessionProvider } from "./supabase";

export type { Session, SessionProvider } from "./session";
export { toActor } from "./session";
export { createStubSessionProvider } from "./stub";
export { createSupabaseSessionProvider } from "./supabase";
export { RUNTIME_DB_ROLE, withUser } from "./with-user";

/**
 * 既定の SessionProvider。
 * Supabase の env が設定されていれば Supabase 実装（現状スケルトン）、
 * 未設定なら「常に未ログイン」のスタブを返す。env は遅延・寛容方式なので
 * このモジュールの import 自体でビルドが壊れることはない。
 */
export function getDefaultSessionProvider(): SessionProvider {
  if (env.supabaseUrl !== undefined && env.supabaseAnonKey !== undefined) {
    return createSupabaseSessionProvider();
  }
  return createStubSessionProvider(null);
}
