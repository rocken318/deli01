"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server-client";
import { sanitizeNext } from "@/lib/auth/next-path";

export interface LoginState {
  error: string | null;
}

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  next: z.string().optional(),
});

export async function signIn(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) {
    return { error: "メールアドレスとパスワードを正しく入力してください。" };
  }
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    return { error: "認証が未設定です。管理者に連絡してください。" };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    // 詳細は伏せる（総当り対策）。ログにも生メッセージは残さない。
    return { error: "メールアドレスまたはパスワードが違います。" };
  }

  redirect(sanitizeNext(parsed.data.next));
}

export async function signOut(): Promise<void> {
  if (env.supabaseUrl && env.supabaseAnonKey) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
