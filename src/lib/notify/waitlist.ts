import "server-only";
import type { Sql } from "postgres";
import type { Session } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { buildNotification, notificationDedupeKey } from "@/domain/notify";
import { sendNotification } from "./sender";
import { getTherapistSlots } from "@/lib/availability/public-slots";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import type { TransactionSql } from "postgres";

/**
 * キャンセル待ち通知の生成（フェーズ20 / spec L656-660・受入 L1122）。
 *
 * 発火契機: 予約の cancelled / noshow 遷移後に cancel-actions.ts から呼ぶ。
 * - waitlists（status='waiting'）のうち希望条件に合致するものを抽出
 * - 空き枠エンジンで実在確認してから通知（条件に合う枠がないときは送らない）
 * - 「空きました」の案内のみ。先着仮押さえ権は与えない（spec L660）
 * - dedupe_key: 'waitlist_open:{waitlist_id}:{YYYY-MM-DD}'
 * - 通知後は waitlists.status='notified' に進める
 * - best-effort: 失敗しても呼び出し元のキャンセルは成立
 */
export interface EnqueueWaitlistParams {
  /** 空いた枠の営業日（Asia/Tokyo 'YYYY-MM-DD'） */
  dateISO: string;
  areaId?: string | null;
  therapistId?: string | null;
  courseId?: string | null;
  now?: Date;
}

export interface EnqueueWaitlistResult {
  enqueued: number;
  sent: number;
}

export async function enqueueWaitlistNotifications(
  sql: Sql,
  session: Session,
  params: EnqueueWaitlistParams,
): Promise<EnqueueWaitlistResult> {
  const now = params.now ?? new Date();

  // 1. 今日以降の希望日のみ対象（過去の待ちは送らない）
  const nowDateJST = format(toZonedTime(now, "Asia/Tokyo"), "yyyy-MM-dd");
  if (params.dateISO < nowDateJST) return { enqueued: 0, sent: 0 };

  return withUser(sql, session, async (tx) => {
    // 2. 希望条件に合致する waiting 待ちを取得
    const candidates = await tx<
      {
        id: string;
        phone: string;
        customer_id: string | null;
        desired_date: string;
        time_from: string | null;
        time_to: string | null;
        area_id: string | null;
        therapist_id: string | null;
        course_id: string | null;
        customer_name: string | null;
      }[]
    >`
      select
        w.id::text as id,
        w.phone,
        w.customer_id::text as customer_id,
        w.desired_date::text as desired_date,
        w.time_from::text as time_from,
        w.time_to::text as time_to,
        w.area_id::text as area_id,
        w.therapist_id::text as therapist_id,
        w.course_id::text as course_id,
        c.name as customer_name
      from waitlists w
      left join customers c on c.id = w.customer_id
      where w.status = 'waiting'
        and w.desired_date = ${params.dateISO}::date
        and (w.area_id is null or w.area_id = ${params.areaId ?? null}::uuid)
        and (w.therapist_id is null or w.therapist_id = ${params.therapistId ?? null}::uuid)
        and (w.course_id is null or w.course_id = ${params.courseId ?? null}::uuid)
      order by w.created_at asc
    `;

    if (candidates.length === 0) return { enqueued: 0, sent: 0 };

    // 3. 空き枠の実在確認
    // therapist_id が分かっている場合は slug を解決してエンジンで確認。
    // therapist_id が不明（エリア待ち・コース待ち）は shift 存在のみ確認（保守的）。
    let hasRealSlot = false;
    if (params.therapistId) {
      try {
        const slugRows = await tx<{ slug: string }[]>`
          select slug from therapists where id = ${params.therapistId}::uuid limit 1
        `;
        const slug = slugRows[0]?.slug;
        if (slug) {
          const result = await getTherapistSlots({
            slug,
            dateISO: params.dateISO,
            areaId: params.areaId ?? null,
          });
          hasRealSlot = result != null && result.slots.length > 0;
        } else {
          // slug 未解決: 保守的に送信しない
          hasRealSlot = false;
        }
      } catch {
        // エンジン呼び出し失敗時は保守的に通知しない
        return { enqueued: 0, sent: 0 };
      }
    } else if (params.areaId) {
      // セラピスト不問・エリア待ち: その日・そのエリアに出勤予定があれば通知
      hasRealSlot = await hasShiftOnDate(tx, params.dateISO, params.areaId);
    } else {
      // 条件が緩い（日付のみ）: 送信する（見逃しゼロ優先）
      hasRealSlot = true;
    }
    if (!hasRealSlot) return { enqueued: 0, sent: 0 };

    // 4. 通知テンプレ読込
    const templateRows = await tx<{ subject: string; body: string }[]>`
      select subject, body
      from notification_templates
      where kind = 'waitlist_open' and is_active = true
      limit 1
    `;
    const template = templateRows[0];
    if (!template) return { enqueued: 0, sent: 0 };

    const dateLabel = params.dateISO; // YYYY-MM-DD（CMS で整形してよい）

    let enqueued = 0;
    let sent = 0;

    for (const w of candidates) {
      const dedupeKey = `waitlist_open:${w.id}:${params.dateISO}`;
      const built = buildNotification({
        subjectTemplate: template.subject,
        bodyTemplate: template.body,
        vars: {
          顧客名: w.customer_name ?? "",
          日付: dateLabel,
          エリア: params.areaId ?? "",
        },
      });

      // 5. on conflict do nothing で重複防止（DB unique が最終防衛線）
      const inserted = await tx<{ id: string }[]>`
        insert into notifications
          (channel, kind, recipient, customer_id, subject, body,
           status, scheduled_for, dedupe_key, created_by)
        values
          ('email', 'waitlist_open'::notification_kind, ${w.phone},
           ${w.customer_id ?? null}::uuid,
           ${built.subject}, ${built.body},
           'pending', ${now}::timestamptz,
           ${dedupeKey},
           ${session.userId}::uuid)
        on conflict (dedupe_key) do nothing
        returning id::text as id
      `;
      if (inserted.length === 0) continue;
      enqueued += 1;

      // 6. スタブ送信
      const notifId = inserted[0]!.id;
      const outcome = await sendNotification({
        id: notifId,
        channel: "email",
        recipient: w.phone,
        subject: built.subject,
        body: built.body,
      });

      if (outcome === "sent") {
        await tx`
          update notifications
          set status = 'sent', sent_at = ${now}::timestamptz
          where id = ${notifId}::bigint
        `;
        // waitlists.status を notified へ
        await tx`
          update waitlists set status = 'notified' where id = ${w.id}::uuid
        `;
        sent += 1;
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
    }

    return { enqueued, sent };
  });
}

/** dedupe_key の公開ヘルパ（テスト用） */
export function waitlistDedupeKey(waitlistId: string, dateISO: string): string {
  return notificationDedupeKey("waitlist_open", `${waitlistId}:${dateISO}`);
}

/** セラピスト不問・日付+エリア待ちの場合: その日に出勤するセラピストがいれば true */
async function hasShiftOnDate(
  tx: TransactionSql,
  dateISO: string,
  areaId: string,
): Promise<boolean> {
  // shifts → shift_areas でエリアに紐づく出勤を確認（0007 スキーマ）
  const rows = await tx<{ cnt: number }[]>`
    select count(*)::integer as cnt
    from shifts s
    join shift_areas sa on sa.shift_id = s.id
    where sa.area_id = ${areaId}::uuid
      and s.work_date = ${dateISO}::date
      and s.is_day_off = false
  `;
  return (rows[0]?.cnt ?? 0) > 0;
}
