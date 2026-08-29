import "server-only";
import { getClient } from "@/lib/db-client";

/**
 * PostGIS 距離ヘルパ（フェーズ6 / spec 5-1）。
 *
 * 境界の整理:
 * - ここ（DB 側）は「2点間の直線距離（メートル）」を ST_Distance(geography) で返すだけ。
 * - 徒歩分数・手段判定・係数・バッファは src/domain/availability/travel.ts の
 *   純粋関数が距離（数値）を受けて行う。DB 依存をドメインに持ち込まない。
 *
 * geography 型の ST_Distance は WGS84 楕円体上のメートルを返す（planar でない）。
 */

/** WGS84 の座標（経度・緯度）。PostGIS は (lon, lat) 順である点に注意 */
export interface GeoPoint {
  lon: number;
  lat: number;
}

function assertPoint(p: GeoPoint, label: string): void {
  if (
    !Number.isFinite(p.lon) ||
    !Number.isFinite(p.lat) ||
    p.lon < -180 ||
    p.lon > 180 ||
    p.lat < -90 ||
    p.lat > 90
  ) {
    throw new RangeError(`${label} が正しい経緯度でない: lon=${p.lon}, lat=${p.lat}`);
  }
}

/**
 * 2点間の直線距離（メートル）。ST_Distance(geography, geography)。
 * 徒歩時間はこの距離を domain の walkMinutes へ渡して算出する。
 */
export async function distanceMeters(from: GeoPoint, to: GeoPoint): Promise<number> {
  assertPoint(from, "from");
  assertPoint(to, "to");
  const sql = getClient();
  const rows = await sql<{ meters: number }[]>`
    select st_distance(
      st_setsrid(st_makepoint(${from.lon}::float8, ${from.lat}::float8), 4326)::geography,
      st_setsrid(st_makepoint(${to.lon}::float8, ${to.lat}::float8), 4326)::geography
    )::float8 as meters
  `;
  const meters = rows[0]?.meters;
  if (meters === undefined) throw new Error("ST_Distance の結果が取得できなかった");
  return meters;
}

/**
 * エリア代表点（areas.center）間の直線距離（メートル）。
 * 車マトリクス未登録ペアの暫定値（provisionalCarMinutes）や、
 * 同一・近接エリアの徒歩判定に使う。center 未設定のエリアが含まれる場合は null。
 */
export async function distanceMetersBetweenAreas(
  fromAreaId: string,
  toAreaId: string,
): Promise<number | null> {
  const sql = getClient();
  const rows = await sql<{ meters: number | null }[]>`
    select st_distance(a.center, b.center)::float8 as meters
    from areas a, areas b
    where a.id = ${fromAreaId}::uuid and b.id = ${toAreaId}::uuid
  `;
  if (rows.length === 0) return null; // 該当エリアなし
  return rows[0]?.meters ?? null;
}
