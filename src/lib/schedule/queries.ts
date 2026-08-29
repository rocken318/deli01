import "server-only";
import { getClient } from "@/lib/db-client";

/**
 * 出勤表（/schedule）の公開読み取り（フェーズ8 / spec 2-1・2-3・3-3）。
 *
 * 方針は src/lib/public/queries.ts と同じ:
 * - **published のみ**。therapists.status='active' かつ entity_records.published が
 *   非 null のセラピストだけを出す（未公開・退職は出勤があっても出さない）。
 * - shifts.is_day_off = true（当日欠勤）は出さない。
 * - area 指定時は shift_areas に該当行があるものだけ。
 *   **出勤していても対応エリア外なら一覧に出ない**（spec 15章 / フェーズ8完了条件）。
 * - RLS 対象テーブルでも読むのは公開可能な列のみなので getClient（BYPASSRLS）直読み。
 * - キャッシュしない（ページ側 force-dynamic）。spec 2-7 の「出勤予定 60秒」は
 *   実行時読取（保存 → 次のリクエストで反映）で満たす。
 */

/** 出勤表の1行（その日に派遣可能なセラピスト） */
export interface ScheduleEntry {
  slug: string;
  displayOrder: number;
  /** entity_records.published（field_definitions 駆動で描画する生の値） */
  published: Record<string, unknown>;
  /** shifts.start_at / end_at（timestamptz） */
  startAt: Date;
  endAt: Date;
  /** 1日の最大施術本数（null = 上限なし）。公開表示には使わずフェーズ9が使う */
  maxBookings: number | null;
  /** その日に対応できるエリア（sort_order 順） */
  areas: ScheduleAreaRef[];
}

/** エリア参照（絞り込みチップ・対応エリア表示に使う） */
export interface ScheduleAreaRef {
  id: string;
  name: string;
}

interface ScheduleRow {
  slug: string;
  display_order: number;
  published: Record<string, unknown> | null;
  start_at: Date;
  end_at: Date;
  max_bookings: number | null;
  areas: ScheduleAreaRef[] | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 指定日の派遣可能セラピスト一覧。
 * areaId を渡すと、その日 shift_areas にそのエリアを持つセラピストだけに絞る。
 * dateISO は "YYYY-MM-DD"（Asia/Tokyo の営業日 = shifts.work_date）。
 */
export async function listDailySchedule(
  dateISO: string,
  areaId?: string | null,
): Promise<ScheduleEntry[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return [];
  const area = areaId && UUID_RE.test(areaId) ? areaId : null;

  const sql = getClient();
  const rows = await sql<ScheduleRow[]>`
    select
      t.slug,
      t.display_order,
      r.published,
      s.start_at,
      s.end_at,
      s.max_bookings,
      coalesce(
        (
          select json_agg(json_build_object('id', a.id, 'name', a.name) order by a.sort_order, a.name)
          from shift_areas sa
          join areas a on a.id = sa.area_id and a.is_active = true
          where sa.shift_id = s.id
        ),
        '[]'::json
      ) as areas
    from shifts s
    join therapists t on t.id = s.therapist_id
    join entity_records r on r.entity = 'therapist' and r.slug = t.slug
    where s.work_date = ${dateISO}
      and s.is_day_off = false
      and t.status = 'active'
      and r.published is not null
      ${
        area
          ? sql`and exists (
              select 1 from shift_areas sa2
              where sa2.shift_id = s.id and sa2.area_id = ${area}::uuid
            )`
          : sql``
      }
    order by t.display_order asc, t.created_at asc
  `;

  return rows
    .filter((r): r is ScheduleRow & { published: Record<string, unknown> } => r.published !== null)
    .map((r) => ({
      slug: r.slug,
      displayOrder: r.display_order,
      published: r.published,
      startAt: r.start_at,
      endAt: r.end_at,
      maxBookings: r.max_bookings,
      areas: r.areas ?? [],
    }));
}

/**
 * 絞り込み UI 用のエリア一覧（is_active のみ・sort_order 順）。
 * エリア名は DB（CMS 管理）由来。公開テンプレートに直書きしない（spec 13-1）。
 */
export async function listScheduleAreas(): Promise<ScheduleAreaRef[]> {
  const sql = getClient();
  const rows = await sql<{ id: string; name: string }[]>`
    select id, name
    from areas
    where is_active = true
    order by sort_order asc, name asc
  `;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}
