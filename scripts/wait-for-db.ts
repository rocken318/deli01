import postgres from "postgres";

/** DB が接続可能になるまで待つ（docker 起動直後 / CI 用）。 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL が未設定です");
  process.exit(1);
}

const MAX_ATTEMPTS = 30;
const INTERVAL_MS = 1000;

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const sql = postgres(url as string, { max: 1, idle_timeout: 2 });
    try {
      await sql`select 1`;
      await sql.end({ timeout: 1 });
      console.log(`DB 接続 OK（${attempt} 回目）`);
      return;
    } catch {
      await sql.end({ timeout: 1 }).catch(() => {});
      if (attempt === MAX_ATTEMPTS) {
        console.error(`DB へ接続できませんでした（${MAX_ATTEMPTS} 回試行）`);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }
}

void main();
