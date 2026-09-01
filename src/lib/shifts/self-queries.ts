import "server-only";
import type { TransactionSql } from "postgres";
import { shiftInstants } from "@/domain/availability";

export interface MyShiftResult {
  id: string;
  areaCount: number;
}

/**
 * キャスト本人の出勤予定を1日ぶん upsert する（RLS 下・therapist セッションで呼ぶ）。
 * - shifts は own を upsert。time（start/end）のみ更新し、base/max は既存値を保持する
 *   （新規時は null）。is_day_off=false に戻す。
 * - 対応エリアは「全アクティブエリア」で全置換（案内表の全員同一エリア方針）。
 * 他人 therapist_id は insert with-check（0021）で拒否される。
 */
export async function upsertMyShiftCore(
  tx: TransactionSql,
  therapistId: string,
  workDate: string,
  startHHMM: string,
  endHHMM: string,
): Promise<MyShiftResult> {
  const { startAt, endAt } = shiftInstants(workDate, startHHMM, endHHMM);

  const rows = await tx<{ id: string }[]>`
    insert into shifts (therapist_id, work_date, start_at, end_at)
    values (${therapistId}, ${workDate}, ${startAt}, ${endAt})
    on conflict (therapist_id, work_date) do update set
      start_at   = excluded.start_at,
      end_at     = excluded.end_at,
      is_day_off = false
    returning id
  `;
  const shift = rows[0];
  if (!shift) throw new Error("出勤の保存に失敗しました");

  // 対応エリア = 全アクティブエリアで全置換
  await tx`delete from shift_areas where shift_id = ${shift.id}`;
  const inserted = await tx<{ area_id: string }[]>`
    insert into shift_areas (shift_id, area_id)
    select ${shift.id}, a.id from areas a where a.is_active = true
    on conflict do nothing
    returning area_id
  `;

  return { id: shift.id, areaCount: inserted.length };
}
