import "server-only";
import type { Sql } from "postgres";
import type { Session } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { buildNotification } from "@/domain/notify";
import { sendNotification } from "./sender";
import { addDays, format } from "date-fns";
import { toZonedTime } from "date-fns-tz";

/**
 * スタッフ宛通知の宛先解決（v1後(a) メール配線）。
 * 運用先メール ops_email が設定されていれば実メール配信先、未設定なら
 * reception_phone にフォールバック（sender はスタブ 'sent'）。両方空なら ""。
 */
export function pickWeeklyRecipient(
  opsEmail: string | undefined,
  receptionPhone: string | undefined,
): string {
  const email = (opsEmail ?? "").trim();
  const phone = (receptionPhone ?? "").trim();
  return email !== "" ? email : phone;
}

/**
 * 週次レポートの生成（フェーズ20 / 受入 L1133「先週分の数字で生成される」）。
 *
 * - 集計元: revenue_lines（売上）・payout_lines（バック）・
 *           lost_orders（不成立件数）・point_entries（失効間近）
 * - 期間: weekStartISO（JST 月曜）〜 +7日 の [from, to)
 * - 宛先: オーナー（app_users role='owner'）
 *         TODO(②): メール収集後に recipient を実メアドに差し替え。
 *         v1 は phone 番号を recipient とする（スタブ）
 * - dedupe_key: 'weekly_report:{weekStartISO}' = 同じ週は1通だけ
 */
export interface GenerateWeeklyReportParams {
  /** レポート対象週の初日（Asia/Tokyo の月曜 'YYYY-MM-DD'） */
  weekStartISO: string;
  now?: Date;
}

export interface GenerateWeeklyReportResult {
  /** 生成した notifications.id（dedupe 済み・未生成は null） */
  notificationId: string | null;
}

export async function generateWeeklyReport(
  sql: Sql,
  session: Session,
  params: GenerateWeeklyReportParams,
): Promise<GenerateWeeklyReportResult> {
  const now = params.now ?? new Date();

  // 期間計算（JST 月曜 00:00:00 〜 翌月曜 00:00:00 を UTC に換算）
  // 文字列で日時計算しない: Date オブジェクトでエポック演算
  const weekStart = new Date(`${params.weekStartISO}T00:00:00+09:00`);
  const weekEnd = addDays(weekStart, 7);

  // 先週分かどうかの確認（今週以降は生成しない）
  const nowJST = toZonedTime(now, "Asia/Tokyo");
  const todayISO = format(nowJST, "yyyy-MM-dd");
  if (params.weekStartISO >= todayISO) {
    // 未来分は生成しない（クーポン乱用防止）
    return { notificationId: null };
  }

  return withUser(sql, session, async (tx) => {
    // 1. オーナーの宛先解決
    // 運用先メール ops_email が設定されていれば実メール配信先（sender が SMTP 送信）。
    // 未設定なら従来どおり reception_phone を暫定識別子に（sender はスタブ 'sent'）。
    const settingRows = await tx<{ key: string; value: unknown }[]>`
      select key, value from site_settings where key in ('ops_email', 'reception_phone')
    `;
    const byKey = Object.fromEntries(
      settingRows.map((r) => [r.key, (r.value as string | undefined) ?? ""]),
    );
    const recipient = pickWeeklyRecipient(byKey.ops_email, byKey.reception_phone);
    if (!recipient) {
      // ops_email も reception_phone も未設定＝通知先が無い。サイト設定で登録すること。
      return { notificationId: null };
    }

    // 2. 通知テンプレ読込
    const templateRows = await tx<{ subject: string; body: string }[]>`
      select subject, body
      from notification_templates
      where kind = 'weekly_report' and is_active = true
      limit 1
    `;
    const template = templateRows[0];
    if (!template) return { notificationId: null };

    // 3. 集計
    // 3a. 売上（revenue_lines・逆仕訳込み）
    const revRows = await tx<{ revenue: number }[]>`
      select coalesce(sum(amount), 0)::integer as revenue
      from revenue_lines
      where occurred_at >= ${weekStart}::timestamptz
        and occurred_at < ${weekEnd}::timestamptz
    `;
    const revenue = revRows[0]?.revenue ?? 0;

    // 3b. バック（payout_lines・reversal_of is null のみ）
    const payRows = await tx<{ payout: number }[]>`
      select coalesce(sum(pl.amount), 0)::integer as payout
      from payout_lines pl
      where pl.business_date >= ${params.weekStartISO}::date
        and pl.business_date < ${format(toZonedTime(weekEnd, "Asia/Tokyo"), "yyyy-MM-dd")}::date
        and pl.reversal_of is null
    `;
    const payout = payRows[0]?.payout ?? 0;

    // 3c. 確定予約件数（cancelled/noshow 除外）
    const resRows = await tx<{ count: number }[]>`
      select count(*)::integer as count
      from reservations
      where start_at >= ${weekStart}::timestamptz
        and start_at < ${weekEnd}::timestamptz
        and status in ('confirmed', 'in_service', 'done')
    `;
    const reservationCount = resRows[0]?.count ?? 0;

    // 3d. 不成立件数（lost_orders）
    const lostRows = await tx<{ count: number }[]>`
      select count(*)::integer as count
      from lost_orders
      where created_at >= ${weekStart}::timestamptz
        and created_at < ${weekEnd}::timestamptz
    `;
    const lostCount = lostRows[0]?.count ?? 0;

    // 3e. 失効間近（30日以内）のポイントロット件数
    const expiryLimit = addDays(now, 30);
    const pointRows = await tx<{ count: number }[]>`
      select count(*)::integer as count
      from point_entries e
      where e.points > 0
        and e.lot_id is null
        and e.expires_at is not null
        and e.expires_at > ${now}::timestamptz
        and e.expires_at <= ${expiryLimit}::timestamptz
        and (e.points + coalesce(
          (select sum(c.points) from point_entries c where c.lot_id = e.id), 0
        )) > 0
    `;
    const expiringPointLots = pointRows[0]?.count ?? 0;

    // 4. 本文組み立て
    const weekLabel = `${params.weekStartISO} 〜 ${format(toZonedTime(addDays(weekStart, 6), "Asia/Tokyo"), "yyyy-MM-dd")}`;
    const grossProfit = revenue - payout;
    const bodyContent = [
      `■ 対象週: ${weekLabel}`,
      ``,
      `売上合計:     ¥${revenue.toLocaleString("ja-JP")}`,
      `バック合計:   ¥${payout.toLocaleString("ja-JP")}`,
      `粗利:         ¥${grossProfit.toLocaleString("ja-JP")}`,
      ``,
      `確定予約件数: ${reservationCount}件`,
      `不成立件数:   ${lostCount}件`,
      ``,
      `失効間近P:    ${expiringPointLots}件 (30日以内)`,
    ].join("\n");

    const built = buildNotification({
      subjectTemplate: template.subject,
      bodyTemplate: template.body,
      vars: {
        週: weekLabel,
        本文: bodyContent,
      },
    });

    // 5. dedupe_key で1週1通保証
    const dedupeKey = `weekly_report:${params.weekStartISO}`;
    const inserted = await tx<{ id: string }[]>`
      insert into notifications
        (channel, kind, recipient, subject, body,
         status, scheduled_for, dedupe_key, created_by)
      values
        ('email', 'weekly_report'::notification_kind, ${recipient},
         ${built.subject}, ${built.body},
         'pending', ${now}::timestamptz,
         ${dedupeKey},
         ${session.userId}::uuid)
      on conflict (dedupe_key) do nothing
      returning id::text as id
    `;
    if (inserted.length === 0) {
      // 既に生成済み（dedupe）
      const existing = await tx<{ id: string }[]>`
        select id::text as id from notifications where dedupe_key = ${dedupeKey} limit 1
      `;
      return { notificationId: existing[0]?.id ?? null };
    }

    const notifId = inserted[0]!.id;

    // 6. スタブ送信
    const outcome = await sendNotification({
      id: notifId,
      channel: "email",
      recipient,
      subject: built.subject,
      body: built.body,
    });

    if (outcome === "sent") {
      await tx`
        update notifications
        set status = 'sent', sent_at = ${now}::timestamptz
        where id = ${notifId}::bigint
      `;
    } else if (outcome === "failed") {
      await tx`
        update notifications
        set status = 'failed', last_error = 'send failed'
        where id = ${notifId}::bigint
      `;
    } else {
      await tx`
        update notifications set status = 'skipped' where id = ${notifId}::bigint
      `;
    }

    return { notificationId: notifId };
  });
}
