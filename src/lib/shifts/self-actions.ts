"use server";

/**
 * キャスト本人による出勤予定の登録（フェーズB / spec 3-3）。
 * - 本人 therapist_id は session（getTherapistDevSession）から解決。クライアントの id は受け取らない。
 * - 単日 / 月・週一括。対応エリアは全アクティブを自動付与（upsertMyShiftCore）。
 * - RLS 下（therapist セッション）で実行。他人の出勤は insert with-check で拒否される。
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTherapistDevSession } from "@/lib/cms/dev-session";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { enumerateShiftDates } from "@/domain/shifts/dates";
import { isRealDateISO } from "@/domain/availability";
import { upsertMyShiftCore } from "@/lib/shifts/self-queries";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "時刻は HH:MM 形式で入力してください");
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日付は YYYY-MM-DD 形式で入力してください")
  .refine(isRealDateISO, "存在しない日付です");

const singleInput = z.object({
  date: dateStr,
  start: hhmm,
  end: hhmm,
  asSlug: z.string().optional(),
});

const bulkInput = z.object({
  rangeStart: dateStr,
  rangeEnd: dateStr,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, "曜日を1つ以上選んでください"),
  start: hhmm,
  end: hhmm,
  asSlug: z.string().optional(),
});

export interface SelfShiftResult {
  ok: boolean;
  count?: number;
  reason?: "unauthenticated" | "no_therapist" | "invalid" | "no_dates" | "error";
}

/** 単日の出勤登録。 */
export async function saveMyShiftAction(input: z.infer<typeof singleInput>): Promise<SelfShiftResult> {
  const parsed = singleInput.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { date, start, end, asSlug } = parsed.data;

  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, reason: "unauthenticated" };

  const sql = getClient();
  const result = await withUser(sql, session, async (tx): Promise<SelfShiftResult> => {
    const who = await tx<{ therapist_id: string | null }[]>`
      select therapist_id from app_users where id = ${session.userId} limit 1
    `;
    const tid = who[0]?.therapist_id;
    if (!tid) return { ok: false, reason: "no_therapist" };
    await upsertMyShiftCore(tx, tid, date, start, end);
    await tx`
      insert into audit_logs (actor_user_id, action, entity, entity_id, after)
      values (${session.userId}, 'self_upsert', 'shift', null, ${tx.json({ workDate: date, start, end })})
    `;
    return { ok: true, count: 1 };
  });

  if (result.ok) revalidatePath("/mypage");
  return result;
}

/** 期間×曜日の一括登録（上限は enumerateShiftDates の 100 日）。 */
export async function saveMyShiftsBulkAction(
  input: z.infer<typeof bulkInput>,
): Promise<SelfShiftResult> {
  const parsed = bulkInput.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { rangeStart, rangeEnd, weekdays, start, end, asSlug } = parsed.data;

  let dates: string[];
  try {
    dates = enumerateShiftDates(rangeStart, rangeEnd, weekdays);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (dates.length === 0) return { ok: false, reason: "no_dates" };

  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, reason: "unauthenticated" };

  const sql = getClient();
  const result = await withUser(sql, session, async (tx): Promise<SelfShiftResult> => {
    const who = await tx<{ therapist_id: string | null }[]>`
      select therapist_id from app_users where id = ${session.userId} limit 1
    `;
    const tid = who[0]?.therapist_id;
    if (!tid) return { ok: false, reason: "no_therapist" };
    for (const workDate of dates) {
      await upsertMyShiftCore(tx, tid, workDate, start, end);
    }
    await tx`
      insert into audit_logs (actor_user_id, action, entity, entity_id, after)
      values (
        ${session.userId}, 'self_bulk_upsert', 'shift', null,
        ${tx.json({ rangeStart, rangeEnd, weekdays, start, end, count: dates.length })}
      )
    `;
    return { ok: true, count: dates.length };
  });

  if (result.ok) revalidatePath("/mypage");
  return result;
}
