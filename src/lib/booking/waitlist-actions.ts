'use server';

/**
 * キャンセル待ちの登録・一覧（フェーズ15 / spec 5 L656-660）。
 *
 * 希望条件（日付・時間帯の範囲・エリア・セラピスト・コース）を登録する。
 * **枠は押さえない**（先着仮押さえ権を与えない / spec L660）。通知（メール/LINE）は
 * フェーズ20。ここでは登録と staff 閲覧まで。公開登録はこの Server Action の特権経路で
 * 行い、クライアント直 DB は許さない（既存の公開予約作成と同方針）。
 */

import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const registerSchema = z.object({
  phone: z.string().regex(/^0[0-9]{9,10}$/u, '電話番号の形式が不正です'),
  desiredDate: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u),
  timeFrom: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).optional(),
  timeTo: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).optional(),
  areaId: z.string().uuid().optional(),
  therapistId: z.string().uuid().optional(),
  courseId: z.string().uuid().optional(),
  note: z.string().max(500).optional(),
});

export type RegisterWaitlistInput = z.infer<typeof registerSchema>;

/**
 * キャンセル待ちを登録する（満枠でなくても登録可）。
 * 公開フォームからも呼ぶため、特権接続で顧客名寄せ（phone）だけ行う。
 */
export async function registerWaitlist(
  input: RegisterWaitlistInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }
  const d = parsed.data;

  const sql = getClient();
  try {
    // 電話番号で既存顧客を名寄せ（無ければ null のまま登録）
    const customers = await sql<{ id: string }[]>`
      select id from customers where phone = ${d.phone} limit 1
    `;
    const customerId = customers[0]?.id ?? null;

    const rows = await sql<{ id: string }[]>`
      insert into waitlists (
        phone, customer_id, desired_date, time_from, time_to,
        area_id, therapist_id, course_id, note
      ) values (
        ${d.phone}, ${customerId}::uuid, ${d.desiredDate}::date,
        ${d.timeFrom ?? null}::time, ${d.timeTo ?? null}::time,
        ${d.areaId ?? null}::uuid, ${d.therapistId ?? null}::uuid,
        ${d.courseId ?? null}::uuid, ${d.note ?? null}
      )
      returning id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('insert failed');
    return { ok: true, data: { id } };
  } catch (e) {
    console.error('registerWaitlist failed:', e);
    return { ok: false, error: 'キャンセル待ちの登録に失敗しました' };
  }
}

export interface WaitlistRow {
  id: string;
  phone: string;
  desiredDate: string;
  timeFrom: string | null;
  timeTo: string | null;
  areaName: string | null;
  therapistName: string | null;
  courseName: string | null;
  status: string;
  note: string | null;
  createdAtISO: string;
}

/** staff 向けのキャンセル待ち一覧（waiting を先に、日付昇順）。 */
export async function listWaitlists(): Promise<ActionResult<WaitlistRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  const actor = toActor(session);
  if (!can(actor, 'manage_reservations')) {
    return { ok: false, error: '閲覧する権限がありません' };
  }

  const sql = getClient();
  const rows = await withUser(sql, session, async (tx) => {
    return tx<{
      id: string;
      phone: string;
      desired_date: Date;
      time_from: string | null;
      time_to: string | null;
      area_name: string | null;
      therapist_name: string | null;
      course_name: string | null;
      status: string;
      note: string | null;
      created_at: Date;
    }[]>`
      select w.id, w.phone, w.desired_date, w.time_from, w.time_to,
             a.name as area_name,
             er.published->>'name' as therapist_name,
             co.name as course_name,
             w.status::text, w.note, w.created_at
      from waitlists w
      left join areas a on a.id = w.area_id
      left join therapists t on t.id = w.therapist_id
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      left join courses co on co.id = w.course_id
      where w.status <> 'closed'
      order by (w.status = 'waiting') desc, w.desired_date asc, w.created_at asc
      limit 100
    `;
  });

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      phone: r.phone,
      desiredDate: r.desired_date.toISOString().slice(0, 10),
      timeFrom: r.time_from,
      timeTo: r.time_to,
      areaName: r.area_name,
      therapistName: r.therapist_name,
      courseName: r.course_name,
      status: r.status,
      note: r.note,
      createdAtISO: r.created_at.toISOString(),
    })),
  };
}
