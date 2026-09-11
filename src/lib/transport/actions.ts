'use server';

/**
 * 送り台帳 Server Actions（設計 4.4）。
 * list/read = manage_reservations（reception も配車運用で参照）。
 * write = manage_reservations（配車チームで登録・更新）。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';

export interface ActionResult<T = void> { ok: boolean; data?: T; error?: string; }

export interface TransportRoute {
  id?: string;
  kind: 'home' | 'dorm' | 'stay';
  destination: string;
  roundTripMin: number | null;
  sortOrder?: number;
}

export interface TransportLedgerRow {
  therapistId: string;
  therapistName: string;
  note: string | null;
  routes: TransportRoute[];
}

export interface TherapistForLedger {
  id: string;
  name: string;
}

const routeSchema = z.object({
  kind: z.enum(['home', 'dorm', 'stay']),
  destination: z.string().min(1, '送り先は必須です').max(500),
  roundTripMin: z.number().int().min(0).nullable().optional(),
});

const saveSchema = z.object({
  therapistId: z.string().uuid(),
  note: z.string().max(2000).nullable().optional(),
  routes: z.array(routeSchema).min(0),
});

export async function listTransportLedger(): Promise<ActionResult<TransportLedgerRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        therapist_id: string;
        therapist_name: string | null;
        note: string | null;
        route_id: string | null;
        kind: string | null;
        destination: string | null;
        round_trip_min: number | null;
        sort_order: number | null;
      }[]>`
        select
          tt.therapist_id,
          coalesce(er.published->>'name', t.slug) as therapist_name,
          tt.note,
          r.id as route_id,
          r.kind::text as kind,
          r.destination,
          r.round_trip_min,
          r.sort_order
        from therapist_transport tt
        join therapists t on t.id = tt.therapist_id
        left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
        left join therapist_transport_routes r on r.transport_id = tt.id
        order by tt.therapist_id, r.sort_order asc, r.id asc
      `;
    });

    // Group by therapist
    const map = new Map<string, TransportLedgerRow>();
    for (const r of rows) {
      if (!map.has(r.therapist_id)) {
        map.set(r.therapist_id, {
          therapistId: r.therapist_id,
          therapistName: r.therapist_name ?? r.therapist_id,
          note: r.note,
          routes: [],
        });
      }
      if (r.route_id) {
        map.get(r.therapist_id)!.routes.push({
          id: r.route_id,
          kind: (r.kind ?? 'home') as 'home' | 'dorm' | 'stay',
          destination: r.destination ?? '',
          roundTripMin: r.round_trip_min,
          sortOrder: r.sort_order ?? 0,
        });
      }
    }
    return { ok: true, data: Array.from(map.values()) };
  } catch (e) {
    console.error('listTransportLedger failed:', e);
    return { ok: false, error: '送り台帳の取得に失敗しました' };
  }
}

export async function getTransportForTherapist(
  therapistId: string,
): Promise<ActionResult<TransportLedgerRow | null>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }
  if (!z.string().uuid().safeParse(therapistId).success) {
    return { ok: false, error: 'IDの形式が不正です' };
  }
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        therapist_id: string;
        therapist_name: string | null;
        note: string | null;
        route_id: string | null;
        kind: string | null;
        destination: string | null;
        round_trip_min: number | null;
        sort_order: number | null;
      }[]>`
        select
          tt.therapist_id,
          coalesce(er.published->>'name', t.slug) as therapist_name,
          tt.note,
          r.id as route_id,
          r.kind::text as kind,
          r.destination,
          r.round_trip_min,
          r.sort_order
        from therapist_transport tt
        join therapists t on t.id = tt.therapist_id
        left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
        left join therapist_transport_routes r on r.transport_id = tt.id
        where tt.therapist_id = ${therapistId}::uuid
        order by r.sort_order asc, r.id asc
      `;
    });
    if (rows.length === 0) return { ok: true, data: null };
    const first = rows[0]!;
    const result: TransportLedgerRow = {
      therapistId: first.therapist_id,
      therapistName: first.therapist_name ?? first.therapist_id,
      note: first.note,
      routes: rows
        .filter((r) => r.route_id !== null)
        .map((r) => ({
          id: r.route_id!,
          kind: (r.kind ?? 'home') as 'home' | 'dorm' | 'stay',
          destination: r.destination ?? '',
          roundTripMin: r.round_trip_min,
          sortOrder: r.sort_order ?? 0,
        })),
    };
    return { ok: true, data: result };
  } catch (e) {
    console.error('getTransportForTherapist failed:', e);
    return { ok: false, error: '送り台帳の取得に失敗しました' };
  }
}

export async function saveTransport(input: {
  therapistId: string;
  note?: string | null;
  routes: Array<{ kind: 'home' | 'dorm' | 'stay'; destination: string; roundTripMin?: number | null }>;
}): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }
  const { therapistId, note, routes } = parsed.data;
  const sql = getClient();
  try {
    await withUser(sql, session, async (tx) => {
      // Upsert therapist_transport
      const tt = await tx<{ id: string }[]>`
        insert into therapist_transport (therapist_id, note)
        values (${therapistId}::uuid, ${note ?? null})
        on conflict (therapist_id) do update set note = excluded.note, updated_at = now()
        returning id
      `;
      const transportId = tt[0]!.id;
      // Delete all existing routes
      await tx`delete from therapist_transport_routes where transport_id = ${transportId}::uuid`;
      // Insert new routes
      if (routes.length > 0) {
        for (let i = 0; i < routes.length; i++) {
          const r = routes[i]!;
          await tx`
            insert into therapist_transport_routes (transport_id, kind, destination, round_trip_min, sort_order)
            values (
              ${transportId}::uuid,
              ${r.kind}::transport_kind,
              ${r.destination},
              ${r.roundTripMin ?? null},
              ${i}
            )
          `;
        }
      }
    });
    revalidatePath('/admin/transport-ledger');
    return { ok: true };
  } catch (e) {
    console.error('saveTransport failed:', e);
    return { ok: false, error: '送り台帳の保存に失敗しました' };
  }
}

export async function deleteTransport(therapistId: string): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }
  if (!z.string().uuid().safeParse(therapistId).success) {
    return { ok: false, error: 'IDの形式が不正です' };
  }
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        delete from therapist_transport where therapist_id = ${therapistId}::uuid returning id
      `;
    });
    if (rows.length === 0) return { ok: false, error: '送り台帳が見つかりません' };
    revalidatePath('/admin/transport-ledger');
    return { ok: true };
  } catch (e) {
    console.error('deleteTransport failed:', e);
    return { ok: false, error: '送り台帳の削除に失敗しました' };
  }
}

export async function listTherapistsForLedger(): Promise<ActionResult<TherapistForLedger[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) {
    return { ok: false, error: '運営権限が必要です' };
  }
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string; name: string }[]>`
        select t.id,
               coalesce(er.published->>'name', t.slug) as name
        from therapists t
        left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
        order by name asc
      `;
    });
    return { ok: true, data: rows.map((r) => ({ id: r.id, name: r.name })) };
  } catch (e) {
    console.error('listTherapistsForLedger failed:', e);
    return { ok: false, error: 'セラピスト一覧の取得に失敗しました' };
  }
}
