"use server";

/**
 * 出勤設定の Server Actions（フェーズ8 / spec 3-3）。
 *
 * - 全アクションは owner/admin のみ（can(actor, 'manage_cms')）+ audit_logs 記録
 * - withUser() 経由で RLS を有効にして実行する
 * - shifts は 1セラピスト×1日 1行（unique）。保存は upsert、対応エリアは全置換
 * - 当日欠勤（is_day_off）はワンタップ切替。行は消さない（spec 3-3）
 * - 月カレンダー・繰り返しパターン（spec 3-3）はフェーズ8完了条件外 → 後続
 *   （README 判断ログ参照）。ここは日別の最小編集
 *
 * STRICT: jsonb 値は tx.json() を使う。JSON.stringify + ::jsonb は禁止。
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can } from "@/domain/auth";
import { shiftInstants } from "@/domain/availability";
import { enumerateShiftDates } from "@/domain/shifts/dates";
import { toActor } from "@/lib/auth/session";
import type { Session } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";

// ---------------------------------------------------------------------------
// 型（管理画面の表示用）
// ---------------------------------------------------------------------------

export interface ShiftBoardTherapist {
  id: string;
  slug: string;
  /** entity_records.draft.name（無ければ空文字。表示は slug でフォールバック） */
  name: string;
  shift: ShiftBoardShift | null;
}

export interface ShiftBoardShift {
  id: string;
  startAt: Date;
  endAt: Date;
  baseStartId: string | null;
  baseEndId: string | null;
  maxBookings: number | null;
  note: string | null;
  isDayOff: boolean;
  areaIds: string[];
}

export interface ShiftBoardOptionItem {
  id: string;
  name: string;
}

export interface ShiftBoard {
  date: string;
  therapists: ShiftBoardTherapist[];
  bases: ShiftBoardOptionItem[];
  areas: ShiftBoardOptionItem[];
}

// ---------------------------------------------------------------------------
// 共通ガード
// ---------------------------------------------------------------------------

async function requireCmsSession(): Promise<Session> {
  const session = await getDevSession();
  if (!session) throw new Error("認証が必要です");
  if (!can(toActor(session), "manage_cms")) {
    throw new Error("この操作には owner または admin のロールが必要です");
  }
  return session;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付は YYYY-MM-DD 形式");
const hhmmSchema = z.string().regex(/^([0-1]\d|2[0-3]):[0-5]\d$/, "時刻は HH:MM 形式");
const uuidSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// 一覧（セラピスト×指定日の出勤予定）
// ---------------------------------------------------------------------------

interface TherapistRow {
  id: string;
  slug: string;
  name: string | null;
}

interface ShiftRow {
  id: string;
  therapist_id: string;
  start_at: Date;
  end_at: Date;
  base_start_id: string | null;
  base_end_id: string | null;
  max_bookings: number | null;
  note: string | null;
  is_day_off: boolean;
  area_ids: string[] | null;
}

/** 指定日の出勤設定ボード（active セラピスト全員 + その日の shift + 選択肢） */
export async function getShiftBoard(dateISO: string): Promise<ShiftBoard> {
  const session = await requireCmsSession();
  const date = dateSchema.parse(dateISO);
  const sql = getClient();

  return withUser(sql, session, async (tx) => {
    const therapistRows = await tx<TherapistRow[]>`
      select t.id, t.slug, r.draft->>'name' as name
      from therapists t
      left join entity_records r on r.entity = 'therapist' and r.slug = t.slug
      where t.status = 'active'
      order by t.display_order asc, t.created_at asc
    `;
    const shiftRows = await tx<ShiftRow[]>`
      select
        s.id, s.therapist_id, s.start_at, s.end_at,
        s.base_start_id, s.base_end_id, s.max_bookings, s.note, s.is_day_off,
        (
          select array_agg(sa.area_id) from shift_areas sa where sa.shift_id = s.id
        ) as area_ids
      from shifts s
      where s.work_date = ${date}
    `;
    const baseRows = await tx<{ id: string; name: string }[]>`
      select id, name from bases where is_active = true order by name asc
    `;
    const areaRows = await tx<{ id: string; name: string }[]>`
      select id, name from areas where is_active = true order by sort_order asc, name asc
    `;

    const shiftByTherapist = new Map<string, ShiftBoardShift>();
    for (const s of shiftRows) {
      shiftByTherapist.set(s.therapist_id, {
        id: s.id,
        startAt: s.start_at,
        endAt: s.end_at,
        baseStartId: s.base_start_id,
        baseEndId: s.base_end_id,
        maxBookings: s.max_bookings,
        note: s.note,
        isDayOff: s.is_day_off,
        areaIds: s.area_ids ?? [],
      });
    }

    return {
      date,
      therapists: therapistRows.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name ?? "",
        shift: shiftByTherapist.get(t.id) ?? null,
      })),
      bases: baseRows,
      areas: areaRows,
    };
  });
}

// ---------------------------------------------------------------------------
// 保存（追加 / 更新。対応エリアは全置換）
// ---------------------------------------------------------------------------

const saveShiftSchema = z.object({
  therapistId: uuidSchema,
  workDate: dateSchema,
  start: hhmmSchema,
  end: hhmmSchema,
  baseStartId: uuidSchema.nullable(),
  baseEndId: uuidSchema.nullable(),
  maxBookings: z.number().int().positive().nullable(),
  note: z.string().max(500).nullable(),
  areaIds: z.array(uuidSchema).min(1, "対応エリアを1つ以上選択してください"),
});

function optionalUuid(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

/**
 * 出勤予定の保存（form action）。
 * 同一セラピスト×日付があれば時間・待機場所・上限・エリアを上書きする。
 * 保存した瞬間に公開ページへ反映される（/schedule は force-dynamic / spec 3-3）。
 */
export async function saveShiftAction(formData: FormData): Promise<void> {
  const session = await requireCmsSession();

  const maxRaw = formData.get("maxBookings");
  const maxStr = typeof maxRaw === "string" ? maxRaw.trim() : "";
  const noteRaw = formData.get("note");
  const noteStr = typeof noteRaw === "string" ? noteRaw.trim() : "";

  const parsed = saveShiftSchema.safeParse({
    therapistId: formData.get("therapistId"),
    workDate: formData.get("workDate"),
    start: formData.get("start"),
    end: formData.get("end"),
    baseStartId: optionalUuid(formData.get("baseStartId")),
    baseEndId: optionalUuid(formData.get("baseEndId")),
    maxBookings: maxStr.length > 0 ? Number(maxStr) : null,
    note: noteStr.length > 0 ? noteStr : null,
    areaIds: formData.getAll("areaIds").filter((v): v is string => typeof v === "string"),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join(", "));
  }
  const data = parsed.data;
  // 営業日 + HH:MM → timestamptz（終了 <= 開始 は日跨ぎとして翌日 / Asia/Tokyo）
  const { startAt, endAt } = shiftInstants(data.workDate, data.start, data.end);

  const sql = getClient();
  await withUser(sql, session, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into shifts
        (therapist_id, work_date, start_at, end_at,
         base_start_id, base_end_id, max_bookings, note)
      values (
        ${data.therapistId}::uuid, ${data.workDate},
        ${startAt}, ${endAt},
        ${data.baseStartId}::uuid, ${data.baseEndId}::uuid,
        ${data.maxBookings}, ${data.note}
      )
      on conflict (therapist_id, work_date) do update set
        start_at      = excluded.start_at,
        end_at        = excluded.end_at,
        base_start_id = excluded.base_start_id,
        base_end_id   = excluded.base_end_id,
        max_bookings  = excluded.max_bookings,
        note          = excluded.note
      returning id
    `;
    const shift = rows[0];
    if (!shift) throw new Error("保存に失敗しました");

    // 対応エリアは全置換（その日に対応できるエリア / spec 3-3）
    await tx`delete from shift_areas where shift_id = ${shift.id}::uuid`;
    for (const areaId of data.areaIds) {
      await tx`
        insert into shift_areas (shift_id, area_id)
        values (${shift.id}::uuid, ${areaId}::uuid)
        on conflict do nothing
      `;
    }

    await tx`
      insert into audit_logs (actor_user_id, action, entity, entity_id, after)
      values (
        ${session.userId}::uuid, 'upsert', 'shift', ${shift.id}::uuid,
        ${tx.json({
          therapistId: data.therapistId,
          workDate: data.workDate,
          start: data.start,
          end: data.end,
          maxBookings: data.maxBookings,
          areaIds: data.areaIds,
        })}
      )
    `;
  });

  revalidatePath("/admin/shifts");
}

// ---------------------------------------------------------------------------
// 月/週まとめて入力（spec 3-3「繰り返しパターン」/ 判断ログ#17 の宿題）
// ---------------------------------------------------------------------------

const bulkShiftSchema = z.object({
  therapistId: uuidSchema,
  rangeStart: dateSchema,
  rangeEnd: dateSchema,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, "曜日を1つ以上選択してください"),
  start: hhmmSchema,
  end: hhmmSchema,
  baseStartId: uuidSchema.nullable(),
  baseEndId: uuidSchema.nullable(),
  maxBookings: z.number().int().positive().nullable(),
  note: z.string().max(500).nullable(),
  areaIds: z.array(uuidSchema).min(1, "対応エリアを1つ以上選択してください"),
});

/**
 * 出勤予定の一括保存（form action）。期間×曜日パターンで該当する全日付に
 * 同じ内容の出勤を upsert する（既存日は上書き・冪等）。対応エリアは全置換。
 */
export async function saveShiftsBulkAction(formData: FormData): Promise<void> {
  const session = await requireCmsSession();

  const maxRaw = formData.get("maxBookings");
  const maxStr = typeof maxRaw === "string" ? maxRaw.trim() : "";
  const noteRaw = formData.get("note");
  const noteStr = typeof noteRaw === "string" ? noteRaw.trim() : "";

  const parsed = bulkShiftSchema.safeParse({
    therapistId: formData.get("therapistId"),
    rangeStart: formData.get("rangeStart"),
    rangeEnd: formData.get("rangeEnd"),
    weekdays: formData
      .getAll("weekdays")
      .filter((v): v is string => typeof v === "string")
      .map(Number),
    start: formData.get("start"),
    end: formData.get("end"),
    baseStartId: optionalUuid(formData.get("baseStartId")),
    baseEndId: optionalUuid(formData.get("baseEndId")),
    maxBookings: maxStr.length > 0 ? Number(maxStr) : null,
    note: noteStr.length > 0 ? noteStr : null,
    areaIds: formData.getAll("areaIds").filter((v): v is string => typeof v === "string"),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join(", "));
  }
  const data = parsed.data;

  const dates = enumerateShiftDates(data.rangeStart, data.rangeEnd, data.weekdays);
  if (dates.length === 0) {
    throw new Error("該当する日がありません（曜日と期間を確認してください）");
  }

  const sql = getClient();
  await withUser(sql, session, async (tx) => {
    for (const workDate of dates) {
      const { startAt, endAt } = shiftInstants(workDate, data.start, data.end);
      const rows = await tx<{ id: string }[]>`
        insert into shifts
          (therapist_id, work_date, start_at, end_at,
           base_start_id, base_end_id, max_bookings, note)
        values (
          ${data.therapistId}::uuid, ${workDate},
          ${startAt}, ${endAt},
          ${data.baseStartId}::uuid, ${data.baseEndId}::uuid,
          ${data.maxBookings}, ${data.note}
        )
        on conflict (therapist_id, work_date) do update set
          start_at      = excluded.start_at,
          end_at        = excluded.end_at,
          base_start_id = excluded.base_start_id,
          base_end_id   = excluded.base_end_id,
          max_bookings  = excluded.max_bookings,
          note          = excluded.note,
          is_day_off    = false
        returning id
      `;
      const shift = rows[0];
      if (!shift) throw new Error("保存に失敗しました");

      await tx`delete from shift_areas where shift_id = ${shift.id}::uuid`;
      for (const areaId of data.areaIds) {
        await tx`
          insert into shift_areas (shift_id, area_id)
          values (${shift.id}::uuid, ${areaId}::uuid)
          on conflict do nothing
        `;
      }
    }

    await tx`
      insert into audit_logs (actor_user_id, action, entity, entity_id, after)
      values (
        ${session.userId}::uuid, 'bulk_upsert', 'shift', null,
        ${tx.json({
          therapistId: data.therapistId,
          rangeStart: data.rangeStart,
          rangeEnd: data.rangeEnd,
          weekdays: data.weekdays,
          count: dates.length,
          start: data.start,
          end: data.end,
          maxBookings: data.maxBookings,
          areaIds: data.areaIds,
        })}
      )
    `;
  });

  revalidatePath("/admin/shifts");
}

// ---------------------------------------------------------------------------
// 当日欠勤ワンタップ（spec 3-3「本日休み」）
// ---------------------------------------------------------------------------

const dayOffSchema = z.object({
  shiftId: uuidSchema,
  isDayOff: z.boolean(),
});

/**
 * 当日欠勤の切替（form action）。行は消さず is_day_off を反転する。
 * 既存予約の一覧表示・振替導線は予約テーブル導入後（フェーズ11以降）に足す。
 */
export async function setShiftDayOffAction(formData: FormData): Promise<void> {
  const session = await requireCmsSession();
  const parsed = dayOffSchema.safeParse({
    shiftId: formData.get("shiftId"),
    isDayOff: formData.get("isDayOff") === "1",
  });
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join(", "));
  }
  const { shiftId, isDayOff } = parsed.data;

  const sql = getClient();
  await withUser(sql, session, async (tx) => {
    const rows = await tx<{ id: string; is_day_off: boolean }[]>`
      update shifts set is_day_off = ${isDayOff}
      where id = ${shiftId}::uuid
      returning id, is_day_off
    `;
    const updated = rows[0];
    if (!updated) throw new Error("対象の出勤予定が見つかりません");

    await tx`
      insert into audit_logs (actor_user_id, action, entity, entity_id, after)
      values (
        ${session.userId}::uuid, 'update', 'shift', ${shiftId}::uuid,
        ${tx.json({ isDayOff })}
      )
    `;
  });

  revalidatePath("/admin/shifts");
}

// ---------------------------------------------------------------------------
// 削除（予定の取り消し。欠勤とは別 = 行ごと消す）
// ---------------------------------------------------------------------------

const deleteSchema = z.object({ shiftId: uuidSchema });

/** 出勤予定の削除（form action）。shift_areas は FK cascade で消える */
export async function deleteShiftAction(formData: FormData): Promise<void> {
  const session = await requireCmsSession();
  const parsed = deleteSchema.safeParse({ shiftId: formData.get("shiftId") });
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join(", "));
  }
  const { shiftId } = parsed.data;

  const sql = getClient();
  await withUser(sql, session, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      delete from shifts where id = ${shiftId}::uuid returning id
    `;
    if (!rows[0]) throw new Error("対象の出勤予定が見つかりません");

    await tx`
      insert into audit_logs (actor_user_id, action, entity, entity_id)
      values (${session.userId}::uuid, 'delete', 'shift', ${shiftId}::uuid)
    `;
  });

  revalidatePath("/admin/shifts");
}
