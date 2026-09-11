'use server';

/** ホテルリスト参照（設計 5.4）。reception 以上が予約中に即答するための read-only ビュー。 */
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { deriveHotelRecord, type HotelRecord } from '@/domain/hotels/record';

export interface ActionResult<T = void> { ok: boolean; data?: T; error?: string; }

export interface HotelLookupRow {
  id: string; name: string; areaName: string | null; address: string | null;
  entryNote: string | null; cardKeyRequired: boolean;
  guestChargeNote: string | null; accessNote: string | null;
  mapsUrl: string | null; isBlocked: boolean; record: HotelRecord;
}

export async function listHotelsLookup(): Promise<ActionResult<HotelLookupRow[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string; name: string; area_name: string | null; address: string | null;
        entry_note: string | null; card_key_required: boolean;
        guest_charge_note: string | null; access_note: string | null;
        maps_url: string | null; is_blocked: boolean;
      }[]>`
        select h.id, h.name, ar.name as area_name, h.address, h.entry_note,
               h.card_key_required, h.guest_charge_note, h.access_note, h.maps_url, h.is_blocked
        from hotels h
        left join areas ar on ar.id = h.area_id
        order by h.name asc`;
    });
    return { ok: true, data: rows.map((r) => ({
      id: r.id, name: r.name, areaName: r.area_name, address: r.address,
      entryNote: r.entry_note, cardKeyRequired: r.card_key_required,
      guestChargeNote: r.guest_charge_note, accessNote: r.access_note,
      mapsUrl: r.maps_url, isBlocked: r.is_blocked,
      record: deriveHotelRecord(r.is_blocked, r.entry_note),
    })) };
  } catch (e) {
    console.error('listHotelsLookup failed:', e);
    return { ok: false, error: 'ホテルリストの取得に失敗しました' };
  }
}
