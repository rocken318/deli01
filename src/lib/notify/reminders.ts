import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { buildNotification, reminderSchedule } from "@/domain/notify";
import type { ReminderKind } from "@/domain/notify";
import { sendNotification } from "./sender";

/**
 * リマインドのスケジューリング（フェーズ20 / 受入 L1131 ★）。
 *
 * 「前日と2時間前に1回ずつだけ・重複送信しない」の担保:
 * - 生成: 予約ごとに reminderSchedule（start_at−24h / −2h）の2件を
 *   dedupe_key（'{kind}:{reservation_id}'）付きで insert。
 *   `on conflict (dedupe_key) do nothing` + DB の unique(dedupe_key) が
 *   最終防衛線（アプリの existence チェックに頼らない）。
 * - 送信: due（scheduled_for <= now）の pending 行をスタブ送信（sender.ts）し
 *   status='sent' + sent_at を刻む。二度目のバッチは dedupe で 0 件生成・
 *   sent 行は再送しないため、同一予約に各種1通ずつで閉じる。
 *
 * cron 配線は未（本フェーズは関数まで）。想定は 5〜10 分間隔で
 * enqueueDueReminders(new Date()) を呼ぶ（Vercel Cron / 手動実行どちらでも）。
 * 遅れて起動しても「過ぎた予定は今送る・ただし1回だけ」に倒れる
 * （予約が start−24h より後に確定した場合、前日分は確定直後のバッチで1回送られる）。
 */

const REMINDER_KINDS: readonly ReminderKind[] = ["reminder_prev_day", "reminder_2h"];

interface ReminderTemplate {
  kind: ReminderKind;
  subject: string;
  body: string;
}

async function loadReminderTemplates(
  tx: TransactionSql,
): Promise<Map<ReminderKind, ReminderTemplate>> {
  const rows = await tx<{ kind: string; subject: string; body: string }[]>`
    select kind::text as kind, subject, body
    from notification_templates
    where kind in ('reminder_prev_day', 'reminder_2h') and is_active = true
  `;
  const map = new Map<ReminderKind, ReminderTemplate>();
  for (const r of rows) {
    if (r.kind === "reminder_prev_day" || r.kind === "reminder_2h") {
      map.set(r.kind, { kind: r.kind, subject: r.subject, body: r.body });
    }
  }
  return map;
}

export interface EnqueueDueRemindersResult {
  /** 今回新規に作成した通知行数（dedupe 済みは数えない） */
  enqueued: number;
  /** 今回 sent に進めた通知行数（過去バッチ生成分の due を含む） */
  sent: number;
}

/**
 * 「今 due なリマインドを生成し、スタブ送信する」バッチ関数。
 *
 * 対象: status='confirmed' かつ start_at が (now, now+24h] の予約。
 * 予約ごとに前日分・2時間前分のうち scheduled_for <= now のものだけを生成する
 * （未来分は次回以降のバッチが生成する。生成済みは unique(dedupe_key) が弾く）。
 */
export async function enqueueDueReminders(
  sql: Sql,
  session: Session,
  now: Date = new Date(),
): Promise<EnqueueDueRemindersResult> {
  return withUser(sql, session, async (tx) => {
    const templates = await loadReminderTemplates(tx);
    if (templates.size === 0) return { enqueued: 0, sent: 0 };

    // 送信対象の確定予約（表示用の JST 整形は DB で行う。文字列で日時計算しない）
    const candidates = await tx<
      {
        id: string;
        start_at: Date;
        customer_id: string | null;
        phone: string | null;
        customer_name: string | null;
        course_name: string;
        therapist_name: string | null;
        therapist_slug: string;
        start_label: string;
      }[]
    >`
      select r.id, r.start_at, r.customer_id,
             c.phone, c.name as customer_name,
             co.name as course_name,
             er.published->>'name' as therapist_name,
             t.slug as therapist_slug,
             to_char(r.start_at at time zone 'Asia/Tokyo', 'MM/DD HH24:MI') as start_label
      from reservations r
      left join customers c on c.id = r.customer_id
      join courses co on co.id = r.course_id
      join therapists t on t.id = r.therapist_id
      left join entity_records er
             on er.entity = 'therapist' and er.slug = t.slug
      where r.status = 'confirmed'
        and r.start_at > ${now}::timestamptz
        and r.start_at <= ${now}::timestamptz + interval '24 hours'
      order by r.start_at asc
    `;

    let enqueued = 0;
    for (const r of candidates) {
      if (!r.phone) continue; // 宛先識別が無ければ生成しない（held 由来の欠損防御）
      const schedule = reminderSchedule({ reservationId: r.id, startAt: r.start_at });
      for (const entry of schedule) {
        if (entry.scheduledFor.getTime() > now.getTime()) continue; // まだ due でない
        const template = templates.get(entry.kind);
        if (!template) continue;
        const built = buildNotification({
          subjectTemplate: template.subject,
          bodyTemplate: template.body,
          vars: {
            顧客名: r.customer_name ?? "",
            日時: r.start_label,
            コース: r.course_name,
            セラピスト: r.therapist_name ?? r.therapist_slug,
          },
        });
        // ★ on conflict (dedupe_key) do nothing = 重複送信の最終防衛線（受入 L1131）
        const inserted = await tx<{ id: string }[]>`
          insert into notifications
            (channel, kind, recipient, reservation_id, customer_id,
             subject, body, status, scheduled_for, dedupe_key, created_by)
          values
            ('email', ${entry.kind}::notification_kind, ${r.phone},
             ${r.id}::uuid, ${r.customer_id}, ${built.subject}, ${built.body},
             'pending', ${entry.scheduledFor}, ${entry.dedupeKey},
             ${session.userId}::uuid)
          on conflict (dedupe_key) do nothing
          returning id::text as id
        `;
        enqueued += inserted.length;
      }
    }

    // due の pending をスタブ送信 → sent へ（②実配線後もこの流れのまま）
    const due = await tx<
      { id: string; channel: "email" | "line"; recipient: string; subject: string; body: string }[]
    >`
      select id::text as id, channel::text as channel, recipient, subject, body
      from notifications
      where status = 'pending'
        and scheduled_for <= ${now}::timestamptz
        and kind in ('reminder_prev_day', 'reminder_2h')
      order by id
    `;
    let sent = 0;
    for (const n of due) {
      const outcome = await sendNotification(n);
      if (outcome === "sent") {
        await tx`
          update notifications
          set status = 'sent', sent_at = ${now}::timestamptz
          where id = ${n.id}::bigint
        `;
        sent += 1;
      } else if (outcome === "failed") {
        await tx`
          update notifications
          set status = 'failed', last_error = 'send failed'
          where id = ${n.id}::bigint
        `;
      } else {
        await tx`
          update notifications set status = 'skipped' where id = ${n.id}::bigint
        `;
      }
    }

    return { enqueued, sent };
  });
}

export { REMINDER_KINDS };
