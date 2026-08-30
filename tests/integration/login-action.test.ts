import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * signIn Server Action のエラー分岐を検証（redirect 成功系は throw のため対象外）。
 * createSupabaseServerClient をモックして signInWithPassword の結果を差し替える。
 */
const mock = vi.hoisted(() => ({
  signInResult: { error: null as { message: string } | null },
  supabaseUrl: "https://example.supabase.co" as string | undefined,
  supabaseAnonKey: "anon" as string | undefined,
}));

vi.mock("@/lib/env", () => ({
  env: {
    get supabaseUrl() {
      return mock.supabaseUrl;
    },
    get supabaseAnonKey() {
      return mock.supabaseAnonKey;
    },
  },
}));

vi.mock("@/lib/auth/supabase-server-client", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      signInWithPassword: async () => mock.signInResult,
    },
  }),
}));

import { signIn } from "@/app/login/actions";

function fd(email: string, password: string, next?: string): FormData {
  const f = new FormData();
  f.set("email", email);
  f.set("password", password);
  if (next !== undefined) f.set("next", next);
  return f;
}

afterEach(() => {
  mock.signInResult = { error: null };
  mock.supabaseUrl = "https://example.supabase.co";
  mock.supabaseAnonKey = "anon";
});

describe("signIn", () => {
  it("入力不正はエラーを返す", async () => {
    const r = await signIn({ error: null }, fd("not-an-email", ""));
    expect(r.error).toBeTruthy();
  });
  it("Supabase 未設定はエラーを返す", async () => {
    mock.supabaseUrl = undefined;
    const r = await signIn({ error: null }, fd("a@example.com", "password123"));
    expect(r.error).toContain("未設定");
  });
  it("資格情報エラーは一般化したメッセージを返す", async () => {
    mock.signInResult = { error: { message: "Invalid login credentials" } };
    const r = await signIn({ error: null }, fd("a@example.com", "wrongpass"));
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain("Invalid login credentials");
  });
});
