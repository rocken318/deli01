import { runCronTick } from "@/lib/cron/tick";

export const dynamic = "force-dynamic";
// スケジュールジョブ一式（reminders/expire/flash/weekly）を1回で回すため長めに確保
export const maxDuration = 60;

/**
 * スケジュール実行の受け口（フェーズ20 ②cron 配線）。
 * Vercel Cron が定期的に GET する（vercel.json の crons）。
 *
 * 認証: `CRON_SECRET` を設定すると Vercel Cron は
 * `Authorization: Bearer <CRON_SECRET>` を付けて叩く。ヘッダ一致のみ許可。
 * 未設定時は本番では拒否（fail-closed）／開発でのみ手動実行を許可する。
 */
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    return req.headers.get("authorization") === `Bearer ${secret}`;
  }
  // secret 未設定: 本番は拒否、開発（vercel dev / local）のみ許可
  return process.env.VERCEL_ENV !== "production" && process.env.NODE_ENV !== "production";
}

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runCronTick();
    const allOk = Object.values(result.jobs).every((j) => j.ok);
    // 一部ジョブ失敗は 207（Multi-Status）で返し、監視で気付けるようにする
    return Response.json({ ok: allOk, ...result }, { status: allOk ? 200 : 207 });
  } catch (e) {
    console.error("[cron] tick failed:", e);
    return Response.json({ ok: false, error: "cron failed" }, { status: 500 });
  }
}
