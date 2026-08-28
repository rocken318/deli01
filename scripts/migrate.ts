import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

/**
 * 手書き SQL マイグレーションのランナー。
 * migrations/*.sql をファイル名昇順で適用し、schema_migrations に記録する。
 * 適用済みはスキップ（冪等）。PostGIS / exclusion / RLS を素の SQL で扱うため
 * drizzle-kit の journal に依存しない（判断ログ #4）。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL が未設定です");
  process.exit(1);
}

async function main() {
  // onnotice を無音化（"extension already exists, skipping" 等の NOTICE でログを汚さない）
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  try {
    // 並行適用（CI と手元、複数プロセス）の競合を防ぐ session advisory lock。
    // キーは定数（利用者入力ではない）なのでインラインで渡す。接続終了で自動解放。
    await sql`select pg_advisory_lock(4823710192837465)`;

    await sql`
      create table if not exists schema_migrations (
        filename    text primary key,
        applied_at  timestamptz not null default now()
      )
    `;

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = new Set(
      (
        await sql<{ filename: string }[]>`select filename from schema_migrations`
      ).map((r) => r.filename),
    );

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const content = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`insert into schema_migrations (filename) values (${file})`;
      });
      console.log(`適用: ${file}`);
      count++;
    }

    console.log(count === 0 ? "適用すべき新規マイグレーションなし" : `${count} 件適用`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((e) => {
  console.error("マイグレーション失敗:", e);
  process.exit(1);
});
