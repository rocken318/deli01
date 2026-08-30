/**
 * 環境変数アクセス（ビルド時に落ちない・遅延検証）。
 *
 * 方針: import した瞬間に throw しない。`next build` のページデータ収集で
 * 本モジュールが芋づる式に読み込まれても、必須値が未設定なだけでビルドを壊さない。
 * 必須値（DATABASE_URL）は「実際に接続する瞬間」にだけ検証する。
 * 発注者提供の任意値（Supabase/OpenAI/Maps）は未設定なら undefined を返すだけ。
 *
 * Server Action の入力検証は Zod で別途行う（spec 1-2）。ここは env なので簡素に保つ。
 */

/** 空文字は未設定として扱う */
function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** 実際に使う瞬間に必須検証する（未設定なら分かりやすく落とす） */
function requireEnv(name: string): string {
  const v = read(name);
  if (!v) {
    throw new Error(
      `環境変数 ${name} が未設定です。ローカルは .env（.env.example 参照）、` +
        `本番/プレビューは各ホスティングの環境変数に設定してください。`,
    );
  }
  return v;
}

export const env = {
  /** DB 接続文字列。接続する瞬間にだけ検証する（ビルドでは呼ばれない） */
  databaseUrl: (): string => requireEnv("DATABASE_URL"),
  /** アプリのタイムゾーン（全処理 Asia/Tokyo） */
  appTz: read("APP_TZ") ?? "Asia/Tokyo",

  // 発注者が用意するもの（未設定でも開発・ビルドは通る / 停止条件②）
  supabaseUrl: read("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: read("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),
  googleMapsApiKey: read("GOOGLE_MAPS_API_KEY"),
  openaiApiKey: read("OPENAI_API_KEY"),
  /** フェーズ21 CMS内AIアシスタント。未設定でもビルド/起動は通る（Vercel のみ設定） */
  anthropicApiKey: read("ANTHROPIC_API_KEY"),
  /** 通知メール送信（フェーズ20 sender 配線）。SMTP 接続 URL（例 smtps://user:pass@host:465）。
   *  未設定ならローカル/CI はスタブ送信のまま（feedback-no-over-configuration） */
  smtpUrl: read("SMTP_URL"),
  /** 通知メールの From（例 "予約 <noreply@example.com>"）。未設定なら実送信しない */
  emailFrom: read("EMAIL_FROM"),
  /** 開発専用セッションスタブ有効化フラグ。本番では絶対に設定しない（spec フェーズ3 優先度0） */
  adminDevSession: read("ADMIN_DEV_SESSION"),
} as const;
