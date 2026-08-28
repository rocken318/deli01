import { z } from "zod";

/**
 * 環境変数の検証（spec: 型だけで通さない）。
 * サーバー専用。クライアントに秘匿値を出さない（spec 19-4）。
 */
const serverSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres")),
  TZ: z.string().default("Asia/Tokyo"),
  // 発注者が用意するもの（未設定でも開発は進む / spec 停止条件②）
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional().or(z.literal("")),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional().or(z.literal("")),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal("")),
  GOOGLE_MAPS_API_KEY: z.string().optional().or(z.literal("")),
  ANTHROPIC_API_KEY: z.string().optional().or(z.literal("")),
});

function loadEnv() {
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`環境変数が不正です:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
