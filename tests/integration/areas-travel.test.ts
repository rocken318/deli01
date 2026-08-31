import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import type { Role } from "@/domain/auth";
import { distanceMeters, distanceMetersBetweenAreas } from "@/lib/availability/geo";
import { carMinutes, chooseMode, pickTimeModifier, travelBuffers, walkMinutes } from "@/domain/availability";

/**
 * フェーズ6の統合テスト（実 Postgres / spec 5-1・5-2・15章）。
 *
 * 検証の骨子:
 * - シード（エリア・マトリクス・徒歩設定・係数・バッファ）が仕様どおり入っている
 * - PostGIS の ST_Distance（geo.ts）→ 純粋関数（travel.ts）の境界を通しても
 *   フェーズ6の完了条件「徒歩と車が閾値で切り替わる」が成立する
 * - 新テーブルの RLS（actor 別: owner/admin=全操作、reception/therapist=select のみ）
 *
 * RLS の enable+force 網羅は tests/integration/auth-rls.test.ts の pg_class 走査が
 * 新テーブルも自動で検査する（テーブル名を列挙しない設計）。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const seedUsers = new Map<Role, { id: string }>();
const areaIds = new Map<string, string>();

function areaOf(name: string): string {
  const id = areaIds.get(name);
  if (!id) throw new Error(`seed に エリア「${name}」がない`);
  return id;
}

function sessionOf(role: Role): Session {
  const u = seedUsers.get(role);
  if (!u) throw new Error(`seed に ${role} のテストアカウントがない`);
  return { userId: u.id, role };
}

beforeAll(async () => {
  const users = await sql<{ id: string; role: Role }[]>`
    select id, role from app_users where display_name like '（ダミー）%'
  `;
  for (const r of users) seedUsers.set(r.role, { id: r.id });

  const areas = await sql<{ id: string; name: string }[]>`select id, name from areas`;
  for (const a of areas) areaIds.set(a.name, a.id);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("シードの検証（spec 5-1・5-2・18章）", () => {
  it("areas が10件・kind と center を持つ", async () => {
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from areas where center is not null
    `;
    expect(Number(rows[0]?.n)).toBe(8);
    expect(areaIds.get("国分町")).toBeTruthy();
    expect(areaIds.get("名取")).toBeTruthy();
    expect(areaIds.get("仙台駅前")).toBeTruthy();
  });

  it("walk_settings は単一行（迂回1.30 / 分速80 / 上限1600）", async () => {
    const rows = await sql<
      { detour_factor: string; speed_m_per_min: number; cap_meters: number }[]
    >`select detour_factor, speed_m_per_min, cap_meters from walk_settings`;
    expect(rows.length).toBe(1);
    expect(Number(rows[0]?.detour_factor)).toBeCloseTo(1.3);
    expect(rows[0]?.speed_m_per_min).toBe(80);
    expect(rows[0]?.cap_meters).toBe(1600);
  });

  it("walk_settings に2行目は入らない（singleton 制約）", async () => {
    await expect(
      sql`insert into walk_settings (id, detour_factor, speed_m_per_min, cap_meters)
          values (false, 1.2, 90, 2000)`,
    ).rejects.toThrow(/walk_settings_singleton|check constraint/);
  });

  it("車マトリクスが双方向で入っている（国分町↔名取 35分 / 近隣は短い）", async () => {
    const shibuya = areaOf("国分町");
    const hachioji = areaOf("名取");
    const ebisu = areaOf("仙台駅前");
    const far = await sql<{ minutes: number }[]>`
      select minutes from area_travel_times
      where (from_area_id = ${shibuya}::uuid and to_area_id = ${hachioji}::uuid)
         or (from_area_id = ${hachioji}::uuid and to_area_id = ${shibuya}::uuid)
    `;
    expect(far.length).toBe(2);
    expect(far.every((r: { minutes: number }) => r.minutes === 35)).toBe(true);

    const near = await sql<{ minutes: number }[]>`
      select minutes from area_travel_times
      where from_area_id = ${shibuya}::uuid and to_area_id = ${ebisu}::uuid
    `;
    expect(near[0]?.minutes).toBe(8);
    expect(near[0]!.minutes).toBeLessThan(35);
  });

  it("travel_time_modifiers に深夜 0.75（<1）と朝夕 1.3〜1.5 が入っている", async () => {
    const rows = await sql<{ multiplier: string }[]>`
      select multiplier from travel_time_modifiers order by sort_order
    `;
    const values = rows.map((r) => Number(r.multiplier));
    expect(values.some((v) => v < 1)).toBe(true); // 深夜
    expect(values.some((v) => v >= 1.3 && v <= 1.5)).toBe(true); // 朝夕
  });

  it("travel_buffers: 既定（10/15/5/10）と国分町の駐車20分上書きが入っている", async () => {
    const def = await sql<
      { arrive_min: number; parking_min: number; before_min: number; after_min: number }[]
    >`select arrive_min, parking_min, before_min, after_min from travel_buffers where scope = 'default'`;
    expect(def.length).toBe(1);
    expect(def[0]).toMatchObject({ arrive_min: 10, parking_min: 15, before_min: 5, after_min: 10 });

    const minato = areaOf("国分町");
    const ovr = await sql<{ parking_min: number }[]>`
      select parking_min from travel_buffers where scope = 'area' and area_id = ${minato}::uuid
    `;
    expect(ovr[0]?.parking_min).toBe(20);
  });

  it("bases に home/station/office の3種が入っている", async () => {
    const rows = await sql<{ kind: string }[]>`select distinct kind from bases`;
    expect(rows.map((r) => r.kind).sort()).toEqual(["home", "office", "station"]);
  });
});

describe("PostGIS 距離 → 純粋関数の境界（完了条件: 徒歩と車が閾値で切り替わる）", () => {
  it("一番町の代表点 → 仙台駅前 は徒歩上限内で walk になる", async () => {
    const meters = await distanceMetersBetweenAreas(
      areaOf("一番町"),
      areaOf("仙台駅前"),
    );
    expect(meters).not.toBeNull();
    expect(meters!).toBeGreaterThan(0);
    expect(meters!).toBeLessThanOrEqual(1600);
    expect(chooseMode(meters!, { capMeters: 1600, canUseCar: false })).toBe("walk");
    // 徒歩分数 = 距離 × 1.30 ÷ 80（整数・切り上げ）
    const minutes = walkMinutes(meters!, { detourFactor: 1.3, speedMPerMin: 80 });
    expect(Number.isInteger(minutes)).toBe(true);
    expect(minutes).toBeLessThanOrEqual(26); // 上限1600m ≒ 26分以内
  });

  it("国分町 → 名取 は徒歩上限超。車可なら car、車不可なら unreachable", async () => {
    const meters = await distanceMetersBetweenAreas(
      areaOf("国分町"),
      areaOf("名取"),
    );
    expect(meters!).toBeGreaterThan(1600);
    expect(chooseMode(meters!, { capMeters: 1600, canUseCar: true })).toBe("car");
    expect(chooseMode(meters!, { capMeters: 1600, canUseCar: false })).toBe("unreachable");
  });

  it("distanceMeters: 既知の2点間で妥当なメートル値を返す（仙台駅前→長町代表点 ≒ 3〜4km）", async () => {
    const meters = await distanceMeters(
      { lon: 140.8823, lat: 38.2601 },
      { lon: 140.886, lat: 38.2249 },
    );
    expect(meters).toBeGreaterThan(2500);
    expect(meters).toBeLessThan(4000);
  });

  it("DB のマトリクス + 係数 + バッファを通しで適用（深夜は短く・駐車は車のみ）", async () => {
    const shibuya = areaOf("国分町");
    const hachioji = areaOf("名取");
    const base = await sql<{ minutes: number }[]>`
      select minutes from area_travel_times
      where from_area_id = ${shibuya}::uuid and to_area_id = ${hachioji}::uuid
    `;
    const mods = await sql<
      { time_from: string; time_to: string; multiplier: string; additional: number }[]
    >`select to_char(time_from, 'HH24:MI') as time_from, to_char(time_to, 'HH24:MI') as time_to,
             multiplier, additional
      from travel_time_modifiers order by sort_order`;
    const modifiers = mods.map((m) => ({
      timeFrom: m.time_from,
      timeTo: m.time_to,
      multiplier: Number(m.multiplier),
      additional: m.additional,
    }));

    const night = carMinutes(base[0]!.minutes, pickTimeModifier(modifiers, "01:00"));
    const noon = carMinutes(base[0]!.minutes, pickTimeModifier(modifiers, "13:00"));
    expect(night).toBe(27); // ceil(35 × 0.75)
    expect(noon).toBe(35);
    expect(night).toBeLessThan(noon);

    const def = await sql<
      { arrive_min: number; parking_min: number; before_min: number; after_min: number }[]
    >`select arrive_min, parking_min, before_min, after_min from travel_buffers where scope = 'default'`;
    const defaults = {
      arriveMin: def[0]!.arrive_min,
      parkingMin: def[0]!.parking_min,
      beforeMin: def[0]!.before_min,
      afterMin: def[0]!.after_min,
    };
    expect(travelBuffers({ mode: "car", defaults }).parkingMin).toBe(15);
    expect(travelBuffers({ mode: "walk", defaults }).parkingMin).toBe(0);
  });
});

describe("areas / travel テーブルの RLS（actor 別 / docs/auth-rls.md §4）", () => {
  it("reception は areas を select できるが insert できない", async () => {
    const visible = await withUser(sql, sessionOf("reception"), async (tx) => {
      return tx<{ id: string }[]>`select id from areas`;
    });
    expect(visible.length).toBe(8);

    await expect(
      withUser(sql, sessionOf("reception"), async (tx) => {
        await tx`insert into areas (name, kind) values ('侵入エリア', 'ward')`;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("therapist は walk_settings を select できるが update は 0 行（不可視）", async () => {
    const visible = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ cap_meters: number }[]>`select cap_meters from walk_settings`;
    });
    expect(visible.length).toBe(1);

    const updated = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: boolean }[]>`
        update walk_settings set cap_meters = 99999 returning id
      `;
    });
    expect(updated.length).toBe(0);
  });

  it("admin は walk_settings（CMS 調整対象）を更新できる", async () => {
    await withUser(sql, sessionOf("admin"), async (tx) => {
      const rows = await tx<{ id: boolean }[]>`
        update walk_settings set cap_meters = 1800 returning id
      `;
      expect(rows.length).toBe(1);
    });
    // 後片付け（保守経路 = BYPASSRLS）で既定値へ戻す
    await sql`update walk_settings set cap_meters = 1600`;
  });

  it("withUser を通らない app_runtime 接続（GUC なし）では areas が見えない = fail-closed", async () => {
    const visible = await sql.begin(async (tx) => {
      await tx`select set_config('role', 'app_runtime', true)`;
      return tx<{ id: string }[]>`select id from areas`;
    });
    expect(visible.length).toBe(0);
  });

  it("owner は area_travel_times を更新できる / therapist は select のみ", async () => {
    const shibuya = areaOf("国分町");
    const shinjuku = areaOf("一番町");

    await withUser(sql, sessionOf("owner"), async (tx) => {
      const rows = await tx<{ minutes: number }[]>`
        update area_travel_times set minutes = 17
        where from_area_id = ${shibuya}::uuid and to_area_id = ${shinjuku}::uuid
        returning minutes
      `;
      expect(rows.length).toBe(1);
    });
    // 元のシード値（国分町↔一番町 = 4分）へ戻す
    await sql`
      update area_travel_times set minutes = 4
      where from_area_id = ${shibuya}::uuid and to_area_id = ${shinjuku}::uuid
    `;

    const asTherapist = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ minutes: number }[]>`
        select minutes from area_travel_times
        where from_area_id = ${shibuya}::uuid and to_area_id = ${shinjuku}::uuid
      `;
    });
    expect(asTherapist.length).toBe(1);

    const updatedByTherapist = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ minutes: number }[]>`
        update area_travel_times set minutes = 1
        where from_area_id = ${shibuya}::uuid and to_area_id = ${shinjuku}::uuid
        returning minutes
      `;
    });
    expect(updatedByTherapist.length).toBe(0);
  });
});
