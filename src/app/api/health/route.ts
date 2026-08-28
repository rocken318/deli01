import { sql } from "drizzle-orm";
import { getDb } from "@/db";

export const dynamic = "force-dynamic";

/**
 * ヘルスチェック。DB 接続と PostGIS の有効性を確認する。
 * デプロイ後の疎通確認・CI のスモークに使う。
 * DB 未設定/未接続でも例外は 503 として返し、プロセスは落とさない。
 */
export async function GET() {
  try {
    const [row] = await getDb().execute<{ postgis: string | null }>(
      sql`select extversion as postgis from pg_extension where extname = 'postgis'`,
    );
    return Response.json({
      ok: true,
      db: "up",
      postgis: row?.postgis ?? null,
    });
  } catch (e) {
    // 詳細（接続先ホスト等を含みうる）はサーバーログにのみ出し、外向きは固定文言
    // （spec 4章「生の Postgres エラーを画面に出さない」の趣旨）。
    console.error("[health] db check failed:", e);
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
