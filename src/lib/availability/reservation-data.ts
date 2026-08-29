import "server-only";
import type { ExistingReservation, PlaceRef, TravelDataSource } from "@/domain/availability";
import type { getClient } from "@/lib/db-client";

/**
 * 既存予約と移動データの読み取り（フェーズ11 / spec 5-3 手順4・8）。
 *
 * フェーズ10 までは reservations が無く、公開側の空き枠は「シフトと移動時間だけ」
 * から計算していた。本フェーズから held / confirmed（+進行中）の予約を
 * ExistingReservation として engine に渡し、隙間（gap）計算と重複除外を効かせる。
 *
 * - 占有区間 = depart_at〜free_at（spec 4章。施術時間だけだと移動中が空きに見える）
 * - status='held' は仮押さえ（spec 5-5）。**期限切れ（slot_holds.expires_at 経過）の
 *   held は参照時に除外**する（cron 解放前でも枠として案内できる）
 * - 予約の地点はエリア代表点（place = "area:{area_id}"）。個別住所座標での精緻化は
 *   ジオコーディング配線後（docs/booking-holds.md）
 */

type SqlClient = ReturnType<typeof getClient>;

/** engine の reservations 入力に使う占有中の予約（期限切れホールドは除外済み） */
export async function loadActiveReservations(
  sql: SqlClient,
  params: {
    therapistId: string;
    /** 参照する時間窓（シフトの start_at / end_at）。窓に重なる占有だけ読む */
    windowStartAt: Date;
    windowEndAt: Date;
  },
): Promise<ExistingReservation[]> {
  const rows = await sql<{ depart_at: Date; free_at: Date; area_id: string }[]>`
    select r.depart_at, r.free_at, r.area_id
    from reservations r
    where r.therapist_id = ${params.therapistId}::uuid
      and r.status in ('held', 'confirmed', 'enroute', 'in_service', 'done')
      and r.free_at > ${params.windowStartAt}
      and r.depart_at < ${params.windowEndAt}
      and not (
        r.status = 'held'
        and exists (
          select 1 from slot_holds h
          where h.reservation_id = r.id and h.expires_at <= now()
        )
      )
    order by r.depart_at asc
  `;
  return rows.map((r) => ({
    departAt: r.depart_at,
    freeAt: r.free_at,
    place: areaPlace(r.area_id),
  }));
}

/** 予約・目的地のエリア代表点 PlaceRef（id 規約 "area:{id}" は公開側と共通） */
export function areaPlace(areaId: string): PlaceRef {
  return { id: `area:${areaId}`, areaId };
}

/**
 * 目的地（エリア代表点 or ホテル所在地）と、待機場所・既存予約エリアとの間の
 * 距離（PostGIS 直線）+ 車マトリクス（area_travel_times）を一括で読み、
 * engine の TravelDataSource を組み立てる。
 *
 * engine の leg は必ず目的地 A を端点に持つ（P→A / A→N）ため、必要な距離は
 * 「目的地 ↔ {base_start, base_end, 各予約エリア}」だけでよい。
 * 車マトリクスは目的地エリア ↔ 各予約エリアの実登録値を引き、未登録は
 * engine 側が距離×係数の暫定値に落とす（spec 5-1）。
 */
export async function buildTravelDataSource(
  sql: SqlClient,
  params: {
    destAreaId: string;
    /** 目的地がホテルのとき。hotels.location があれば代表点より優先する */
    destHotelId?: string | null;
    /** 目的地の PlaceRef id（"area:{id}" / "hotel:{id}"） */
    destPlaceId: string;
    baseStartId: string | null;
    baseEndId: string | null;
    /** 既存予約のエリア id（重複可。内部で一意化） */
    reservationAreaIds: readonly string[];
  },
): Promise<TravelDataSource> {
  const hotelId = params.destHotelId ?? null;
  const areaIds = Array.from(new Set(params.reservationAreaIds));
  const allAreaIds = Array.from(new Set([params.destAreaId, ...areaIds]));

  const [baseRows, areaRows, matrixRows] = await Promise.all([
    sql<{ start_meters: number | null; end_meters: number | null }[]>`
      select
        st_distance(bs.location, d.g)::float8 as start_meters,
        st_distance(be.location, d.g)::float8 as end_meters
      from (
        select coalesce(h.location, a.center) as g
        from areas a
        left join hotels h on h.id = ${hotelId}::uuid
        where a.id = ${params.destAreaId}::uuid
      ) d
      left join bases bs on bs.id = ${params.baseStartId}::uuid
      left join bases be on be.id = ${params.baseEndId}::uuid
    `,
    areaIds.length > 0
      ? sql<{ id: string; meters: number | null }[]>`
          select a.id, st_distance(a.center, d.g)::float8 as meters
          from areas a
          cross join (
            select coalesce(h.location, da.center) as g
            from areas da
            left join hotels h on h.id = ${hotelId}::uuid
            where da.id = ${params.destAreaId}::uuid
          ) d
          where a.id = any(${areaIds}::uuid[])
        `
      : Promise.resolve([] as { id: string; meters: number | null }[]),
    sql<{ from_area_id: string; to_area_id: string; minutes: number }[]>`
      select from_area_id, to_area_id, minutes
      from area_travel_times
      where from_area_id = any(${allAreaIds}::uuid[])
        and to_area_id = any(${allAreaIds}::uuid[])
    `,
  ]);

  const distanceMap = new Map<string, number>();
  const putDistance = (aId: string, bId: string, meters: number | null) => {
    if (meters === null) return;
    distanceMap.set(`${aId}|${bId}`, meters);
    distanceMap.set(`${bId}|${aId}`, meters);
  };
  const baseStartPlaceId = `base:${params.baseStartId ?? "start"}`;
  const baseEndPlaceId = `base:${params.baseEndId ?? "end"}`;
  putDistance(baseStartPlaceId, params.destPlaceId, baseRows[0]?.start_meters ?? null);
  putDistance(baseEndPlaceId, params.destPlaceId, baseRows[0]?.end_meters ?? null);
  for (const row of areaRows) {
    putDistance(areaPlace(row.id).id, params.destPlaceId, row.meters);
  }

  const matrixMap = new Map<string, number>();
  for (const m of matrixRows) {
    matrixMap.set(`${m.from_area_id}|${m.to_area_id}`, m.minutes);
  }

  return {
    distanceMeters: (from, to) => distanceMap.get(`${from.id}|${to.id}`) ?? null,
    carMatrixMinutes: (fromAreaId, toAreaId) =>
      matrixMap.get(`${fromAreaId}|${toAreaId}`) ?? null,
  };
}
