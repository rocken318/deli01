/**
 * 本番 Supabase に管理者アカウントを発行し、既存 app_users に紐付ける（冪等）。
 *
 * 使い方（発注者が本番向けに実行）:
 *   1. 対象を JSON で用意（例 bootstrap-users.json。コミットしないこと）:
 *      [
 *        { "appUserId": "aaaaaaaa-0000-4000-8000-000000000001", "email": "owner@example.com" },
 *        { "appUserId": "aaaaaaaa-0000-4000-8000-000000000002", "email": "admin@example.com" }
 *      ]
 *   2. 環境変数を設定して実行:
 *      NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=... \
 *        pnpm tsx scripts/bootstrap-auth.ts bootstrap-users.json
 *   3. 出力された初期パスワードを各人に安全に配布し、初回ログイン後に変更してもらう。
 *
 * 冪等性: app_users.auth_user_id が既にあればスキップ。同 email の auth ユーザーが
 * 既にあれば作成せず再利用して紐付けだけ行う。
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

interface Target {
  appUserId: string;
  email: string;
  password?: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です。`);
  return v;
}

function genPassword(): string {
  // 記号を避け、配布・入力しやすい 16 文字
  return randomBytes(12).toString("base64url").slice(0, 16);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    throw new Error("使い方: pnpm tsx scripts/bootstrap-auth.ts <targets.json>");
  }

  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const databaseUrl = requireEnv("DATABASE_URL");

  const targets: Target[] = JSON.parse(readFileSync(file, "utf8"));
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    for (const t of targets) {
      const existing = await sql<{ auth_user_id: string | null; role: string }[]>`
        select auth_user_id, role from app_users where id = ${t.appUserId}
      `;
      if (existing.length === 0) {
        console.log(`SKIP  ${t.email}: app_users に ${t.appUserId} が無い`);
        continue;
      }
      if (existing[0]!.auth_user_id) {
        console.log(`SKIP  ${t.email}: 既に紐付け済み (${existing[0]!.role})`);
        continue;
      }

      if (t.password && t.password.length < 12) {
        console.log(`FAIL  ${t.email}: password は 12 文字以上にしてください`);
        continue;
      }
      const password = t.password ?? genPassword();
      let authUserId: string | undefined;

      const created = await admin.auth.admin.createUser({
        email: t.email,
        password,
        email_confirm: true,
      });
      if (created.error) {
        // 既存 email 等 → ページ走査で引いて再利用（既定 50 件/ページの取りこぼし対策）
        let found: { id: string; email?: string } | undefined;
        for (let page = 1; ; page++) {
          const list = await admin.auth.admin.listUsers({ page, perPage: 200 });
          if (list.error) break;
          found = list.data.users.find((u) => u.email === t.email);
          if (found || list.data.users.length < 200) break;
        }
        if (!found) {
          console.log(`FAIL  ${t.email}: ${created.error.message}`);
          continue;
        }
        authUserId = found.id;
        console.log(`REUSE ${t.email}: 既存 auth ユーザーを再利用`);
      } else {
        authUserId = created.data.user.id;
        console.log(`CREATE ${t.email}  初期パスワード: ${password}`);
      }

      await sql`
        update app_users set auth_user_id = ${authUserId} where id = ${t.appUserId}
      `;
      console.log(`LINK  ${t.email} -> app_users ${t.appUserId}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
