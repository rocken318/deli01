import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

/**
 * ヘルスチェック。DB 接続と PostGIS の有効性を確認する。
 * デプロイ後の疎通確認・CI のスモークに使う。
 */
export async function GET() {
  try {
    const [row] = await db.execute<{ postgis: string | null }>(
      sql`select extversion as postgis from pg_extension where extname = 'postgis'`,
    );
    return Response.json({
      ok: true,
      db: "up",
      postgis: row?.postgis ?? null,
    });
  } catch (e) {
    return Response.json(
      { ok: false, db: "down", error: (e as Error).message },
      { status: 503 },
    );
  }
}
