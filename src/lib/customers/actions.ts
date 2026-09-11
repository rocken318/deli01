'use server';

/**
 * 顧客管理 Server Actions（フェーズ13 / spec 13-3）。
 * 電話番号で識別。staff（owner/admin/reception）のみ（manage_reservations）。
 * 金額は整数のみ。any 禁止。クライアントから直接 DB を触らない。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { getPointBalanceCore } from '@/lib/points/queries';
import { getHandoverNotesCore } from '@/lib/handover/queries';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerListRow {
  id: string;
  phone: string;
  name: string;
  nameKana: string | null;
}

export interface RecentReservation {
  id: string;
  dateISO: string;
  therapistName: string;
  courseName: string;
  status: string;
  total: number;
}

export interface NgTherapist {
  therapistId: string;
  therapistName: string;
}

export interface HandoverNoteItem {
  body: string;
  createdAtISO: string;
}

export interface CustomerDetail {
  profile: {
    id: string;
    phone: string;
    name: string;
    nameKana: string | null;
    note: string | null;
  };
  pointsBalance: number;
  recentReservations: RecentReservation[];
  ngTherapists: NgTherapist[];
  handoverNotes: HandoverNoteItem[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const phoneSchema = z.string().regex(/^0[0-9]{9,10}$/, '電話番号は 0 から始まる10〜11桁の数字で入力してください');

const upsertCustomerSchema = z.object({
  id: z.string().uuid().optional(),
  phone: phoneSchema,
  name: z.string().min(1, '氏名は必須です').max(100),
  nameKana: z.string().max(100).optional(),
  note: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// 1. searchCustomers
// ---------------------------------------------------------------------------

/**
 * 電話番号（前方一致）または名前（部分一致）で顧客を検索する。
 * query が空文字なら最近更新順で最大20件返す。
 */
export async function searchCustomers(
  query: string,
): Promise<ActionResult<CustomerListRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限がありません' };
  }

  const q = query.trim();
  const sql = getClient();

  try {
    const rows = await withUser(sql, session, async (tx) => {
      if (q === '') {
        return tx<{ id: string; phone: string; name: string; name_kana: string | null }[]>`
          select id, phone, name, name_kana
          from customers
          order by updated_at desc, created_at desc
          limit 20
        `;
      }

      // 電話番号っぽい（数字のみ）なら前方一致
      if (/^[0-9]+$/.test(q)) {
        return tx<{ id: string; phone: string; name: string; name_kana: string | null }[]>`
          select id, phone, name, name_kana
          from customers
          where phone like ${q + '%'}
          order by phone asc
          limit 20
        `;
      }

      // それ以外は名前部分一致
      return tx<{ id: string; phone: string; name: string; name_kana: string | null }[]>`
        select id, phone, name, name_kana
        from customers
        where name ilike ${'%' + q + '%'}
           or name_kana ilike ${'%' + q + '%'}
        order by name asc
        limit 20
      `;
    });

    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        name: r.name,
        nameKana: r.name_kana,
      })),
    };
  } catch (e) {
    console.error('searchCustomers failed:', e);
    return { ok: false, error: '顧客の検索に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 2. upsertCustomer
// ---------------------------------------------------------------------------

/**
 * 顧客を新規作成または更新する。
 * - id あり → UPDATE
 * - id なし → INSERT（phone unique 違反 → 日本語メッセージ）
 */
export async function upsertCustomer(
  input: z.input<typeof upsertCustomerSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限がありません' };
  }

  const parsed = upsertCustomerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  const d = parsed.data;
  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      if (d.id) {
        // UPDATE
        const rows = await tx<{ id: string }[]>`
          update customers
          set phone      = ${d.phone},
              name       = ${d.name},
              name_kana  = ${d.nameKana ?? null},
              note       = ${d.note ?? null},
              updated_at = now()
          where id = ${d.id}::uuid
          returning id
        `;
        if (!rows[0]) throw new Error('顧客が見つかりません');
        return { id: rows[0].id };
      } else {
        // INSERT
        const rows = await tx<{ id: string }[]>`
          insert into customers (phone, name, name_kana, note)
          values (${d.phone}, ${d.name}, ${d.nameKana ?? null}, ${d.note ?? null})
          returning id
        `;
        if (!rows[0]) throw new Error('登録に失敗しました');
        return { id: rows[0].id };
      }
    });

    revalidatePath('/admin/customers');
    return { ok: true, data: result };
  } catch (e) {
    // phone unique 違反の検出（PostgreSQL error code 23505）
    if (
      e instanceof Error &&
      (e.message.includes('23505') ||
        e.message.toLowerCase().includes('unique') ||
        e.message.toLowerCase().includes('customers_phone_key'))
    ) {
      return { ok: false, error: '同じ電話番号の顧客が既にあります' };
    }
    console.error('upsertCustomer failed:', e);
    return { ok: false, error: '顧客の保存に失敗しました' };
  }
}

// ---------------------------------------------------------------------------
// 3. getCustomerDetail
// ---------------------------------------------------------------------------

/**
 * 顧客詳細を集約して返す。
 * ポイント残高・予約履歴（最新10件）・指名NG・引き継ぎメモを含む。
 */
export async function getCustomerDetail(
  customerId: string,
): Promise<ActionResult<CustomerDetail>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '権限がありません' };
  }

  const parsedId = z.string().uuid().safeParse(customerId);
  if (!parsedId.success) return { ok: false, error: '無効な顧客IDです' };

  const sql = getClient();

  try {
    // 1. プロフィール
    const profileRows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string;
        phone: string;
        name: string;
        name_kana: string | null;
        note: string | null;
      }[]>`
        select id, phone, name, name_kana, note
        from customers
        where id = ${parsedId.data}::uuid
        limit 1
      `;
    });

    const profileRow = profileRows[0];
    if (!profileRow) return { ok: false, error: '顧客が見つかりません' };

    const profile = {
      id: profileRow.id,
      phone: profileRow.phone,
      name: profileRow.name,
      nameKana: profileRow.name_kana,
      note: profileRow.note,
    };

    // 2. ポイント残高（既存クエリ再利用）
    let pointsBalance = 0;
    const balanceResult = await getPointBalanceCore(sql, session, { customerId: parsedId.data });
    if (balanceResult.kind === 'ok') {
      pointsBalance = balanceResult.balance;
    }

    // 3. 予約履歴（最新10件、therapist 表示名は entity_records published->>'name'）
    const reservationRows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string;
        start_at: Date;
        therapist_name: string | null;
        therapist_slug: string;
        course_name: string | null;
        status: string;
        total_amount: number;
      }[]>`
        select r.id,
               r.start_at,
               coalesce(er.published->>'name', t.slug) as therapist_name,
               t.slug as therapist_slug,
               co.name as course_name,
               r.status::text,
               r.total_amount
        from reservations r
        join therapists t on t.id = r.therapist_id
        left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
        left join courses co on co.id = r.course_id
        where r.customer_id = ${parsedId.data}::uuid
          and r.status not in ('held', 'cancelled')
        order by r.start_at desc
        limit 10
      `;
    });

    const recentReservations: RecentReservation[] = reservationRows.map((r) => ({
      id: r.id,
      dateISO: r.start_at.toISOString().slice(0, 10),
      therapistName: r.therapist_name ?? r.therapist_slug,
      courseName: r.course_name ?? '不明',
      status: r.status,
      total: r.total_amount,
    }));

    // 4. 指名NG（既存テーブル直接 select。nomination/actions.ts は全件一覧のみ）
    const ngRows = await withUser(sql, session, async (tx) => {
      return tx<{
        therapist_id: string;
        therapist_name: string | null;
      }[]>`
        select ng.therapist_id,
               coalesce(er.published->>'name', th.slug) as therapist_name
        from customer_therapist_ng ng
        join therapists th on th.id = ng.therapist_id
        left join entity_records er on er.entity = 'therapist' and er.slug = th.slug
        where ng.customer_id = ${parsedId.data}::uuid
        order by ng.created_at desc
      `;
    });

    const ngTherapists: NgTherapist[] = ngRows.map((r) => ({
      therapistId: r.therapist_id,
      therapistName: r.therapist_name ?? r.therapist_id,
    }));

    // 5. 引き継ぎメモ（既存クエリ再利用）
    const handoverRaw = await getHandoverNotesCore(sql, session, { customerId: parsedId.data });
    const handoverNotes: HandoverNoteItem[] = handoverRaw.map((n) => ({
      body: n.body,
      createdAtISO: n.createdAt.toISOString(),
    }));

    return {
      ok: true,
      data: {
        profile,
        pointsBalance,
        recentReservations,
        ngTherapists,
        handoverNotes,
      },
    };
  } catch (e) {
    console.error('getCustomerDetail failed:', e);
    return { ok: false, error: '顧客詳細の取得に失敗しました' };
  }
}
