import type { Sql } from "postgres";
import { toZonedTime } from "date-fns-tz";
import { format, getDay, startOfWeek, subDays } from "date-fns";
import { getClient } from "@/lib/db-client";
import type { Session } from "@/lib/auth/session";
import { releaseExpiredHolds } from "@/lib/booking/holds";
import { enqueueDueReminders } from "@/lib/notify/reminders";
import { generateWeeklyReport } from "@/lib/notify/weekly";
import { expirePointsCore } from "@/lib/points/queries";
import { applyFlashDealCore } from "@/lib/flashdeal/queries";
import { loadFlashDealConfig } from "@/lib/flashdeal/config";

/**
 * cron の中核（フェーズ20 の②cron 配線）。
 *
 * すべてのスケジュール実行を「1回の tick」で束ねる（Vercel Hobby は cron 2本・
 * 日次のみ＝多頻度ジョブを個別に持てないため、単一エンドポイントで内部分岐する）。
 * Pro なら 15分間隔などで頻繁に叩けば 2h 前リマインドも間に合う。Hobby の
 * 日次でも前日リマインド・ポイント失効・週次レポートは成立する（[[docs/cron.md]]）。
 *
 * 各ジョブは独立の try/catch で回し、1つ落ちても他は動かす（best-effort）。
 * すべて冪等（reminders/weekly=unique(dedupe_key)・flash=unique＋is_flash_deal ガード・
 * expire=lot 参照・holds=DB 関数）なので、多重実行しても二重適用しない。
 */

export interface CronJobOutcome {
  ok: boolean;
  detail?: unknown;
  error?: string;
  skipped?: string;
}

export interface CronTickResult {
  ranAt: string;
  jobs: Record<string, CronJobOutcome>;
}

/** cron 実行用のシステムセッション（監査 created_by 等に使う owner） */
async function systemSession(sql: Sql): Promise<Session> {
  const rows = await sql<{ id: string }[]>`
    select id::text as id from app_users
    where role = 'owner' and is_active = true
    order by created_at
    limit 1
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error("cron: 有効な owner の app_users が見つかりません");
  return { userId: id, role: "owner" };
}

/** 本日 JST の confirmed 予約に直前割を試行（対象外は core が弾く＝冪等） */
async function runFlashDealBatch(
  sql: Sql,
  session: Session,
  now: Date,
): Promise<CronJobOutcome> {
  const config = await loadFlashDealConfig(sql);
  if (!config.enabled) return { ok: true, skipped: "disabled" };

  const todayISO = format(toZonedTime(now, "Asia/Tokyo"), "yyyy-MM-dd");
  const todayStart = new Date(`${todayISO}T00:00:00+09:00`);
  const todayEnd = new Date(`${todayISO}T23:59:59+09:00`);

  const targets = await sql<{ id: string }[]>`
    select id::text as id from reservations
    where status = 'confirmed'
      and start_at >= ${todayStart}::timestamptz
      and start_at <= ${todayEnd}::timestamptz
      and is_flash_deal = false
  `;

  let applied = 0;
  let skipped = 0;
  for (const t of targets) {
    const outcome = await applyFlashDealCore(sql, session, {
      reservationId: t.id,
      config,
      now,
    });
    if (outcome.kind === "applied") applied += 1;
    else skipped += 1;
  }
  return { ok: true, detail: { candidates: targets.length, applied, skipped } };
}

/** 月曜のみ先週分の週次レポートを生成（dedupe_key で1週1通） */
async function runWeeklyReport(
  sql: Sql,
  session: Session,
  now: Date,
): Promise<CronJobOutcome> {
  const nowJST = toZonedTime(now, "Asia/Tokyo");
  if (getDay(nowJST) !== 1) return { ok: true, skipped: "not_monday" };

  const thisMonday = startOfWeek(nowJST, { weekStartsOn: 1 });
  const weekStartISO = format(subDays(thisMonday, 7), "yyyy-MM-dd");
  const result = await generateWeeklyReport(sql, session, { weekStartISO, now });
  return { ok: true, detail: result };
}

export async function runCronTick(now: Date = new Date()): Promise<CronTickResult> {
  const sql = getClient();
  const session = await systemSession(sql);
  const jobs: Record<string, CronJobOutcome> = {};

  const run = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      const detail = await fn();
      jobs[name] = detail && typeof detail === "object" && "ok" in detail
        ? (detail as CronJobOutcome)
        : { ok: true, detail };
    } catch (e) {
      jobs[name] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  await run("releaseExpiredHolds", () => releaseExpiredHolds());
  await run("reminders", () => enqueueDueReminders(sql, session, now));
  await run("expirePoints", () => expirePointsCore(sql, session, { now }));
  await run("flashDeals", () => runFlashDealBatch(sql, session, now));
  await run("weeklyReport", () => runWeeklyReport(sql, session, now));

  return { ranAt: now.toISOString(), jobs };
}
