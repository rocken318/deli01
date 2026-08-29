import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import type { Role } from "@/domain/auth";
import { arrivalBuffers, isHotelBookable } from "@/domain/availability";
import type { BufferSettings } from "@/domain/availability";
import { totalPrice, totalServiceMinutes } from "@/domain/catalog";

/**
 * フェーズ7の統合テスト（実 Postgres / spec 3-4・8-2・18-1・18-2・15章）。
 *
 * 検証の骨子:
 * - シード（コース4・オプション5・ホテル）が spec 18章どおり DB に入っている
 *   （= ハードコードでなく CMS から変更可能な形）
 * - ★完了条件「ホテルの館内移動時間が加算される」: DB の hotels.extra_minutes を
 *   純粋関数（arrivalBuffers）へ通し、同一条件の住居より総到着時間が増えること
 * - is_blocked のホテルが isHotelBookable で予約対象外になること（spec 15章）
 * - オプション duration_min が施術時間 L に効くこと（spec 3-4・5-3。DB 値で検証）
 * - 新4テーブルの RLS（actor 別: owner/admin=全操作、reception/therapist=select のみ）
 *
 * RLS の enable+force 網羅は tests/integration/auth-rls.test.ts の pg_class 走査が
 * 新テーブルも自動で検査する（テーブル名を列挙しない設計）。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const seedUsers = new Map<Role, { id: string }>();

function sessionOf(role: Role): Session {
  const u = seedUsers.get(role);
  if (!u) throw new Error(`seed に ${role} のテストアカウントがない`);
  return { userId: u.id, role };
}

/** travel_buffers の既定行（spec 5-2）を BufferSettings に写す */
async function defaultBuffers(): Promise<BufferSettings> {
  const rows = await sql<
    { arrive_min: number; parking_min: number; before_min: number; after_min: number }[]
  >`select arrive_min, parking_min, before_min, after_min from travel_buffers where scope = 'default'`;
  const row = rows[0];
  if (!row) throw new Error("travel_buffers の既定行がない");
  return {
    arriveMin: row.arrive_min,
    parkingMin: row.parking_min,
    beforeMin: row.before_min,
    afterMin: row.after_min,
  };
}

beforeAll(async () => {
  const users = await sql<{ id: string; role: Role }[]>`
    select id, role from app_users where display_name like '（ダミー）%'
  `;
  for (const r of users) seedUsers.set(r.role, { id: r.id });
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("シードの検証（spec 18-1・18-2・8-2 / DB 投入 = CMS から変更可能）", () => {
  it("courses が4件・spec 18-1 の時間と料金（すべて整数の円）", async () => {
    const rows = await sql<
      { name: string; duration_min: number; price: number; nomination_fee_default: number }[]
    >`select name, duration_min, price, nomination_fee_default from courses order by sort_order`;
    expect(rows.map((r) => [r.name, r.duration_min, r.price])).toEqual([
      ["ショート", 60, 12000],
      ["スタンダード", 90, 17000],
      ["ロング", 120, 22000],
      ["スペシャル", 150, 27000],
    ]);
    for (const r of rows) {
      expect(Number.isInteger(r.price)).toBe(true);
      expect(Number.isInteger(r.nomination_fee_default)).toBe(true);
    }
  });

  it("options が5件・spec 18-2 の時間と料金。back_type の fixed/rate 両方の例がある", async () => {
    const rows = await sql<
      { name: string; duration_min: number; price: number; back_type: string; back_value: number }[]
    >`select name, duration_min, price, back_type, back_value from options order by sort_order`;
    expect(rows.map((r) => [r.name, r.duration_min, r.price])).toEqual([
      ["延長30分", 30, 6000],
      ["延長60分", 60, 11000],
      ["アロマオイル", 0, 2000],
      ["ヘッドケア", 15, 2500],
      ["フットケア", 15, 2500],
    ]);
    const types = new Set(rows.map((r) => r.back_type));
    expect(types.has("fixed")).toBe(true);
    expect(types.has("rate")).toBe(true);
  });

  it("option_availability: フットケアは「あおい」限定・他のオプションは行なし = 全員対応（spec 3-4）", async () => {
    const rows = await sql<{ name: string; slug: string }[]>`
      select o.name, t.slug
      from option_availability oa
      join options o on o.id = oa.option_id
      join therapists t on t.id = oa.therapist_id
    `;
    expect(rows).toEqual([{ name: "フットケア", slug: "aoi" }]);

    const unrestricted = await sql<{ n: string }[]>`
      select count(*)::text as n from options o
      where not exists (select 1 from option_availability oa where oa.option_id = o.id)
    `;
    expect(Number(unrestricted[0]?.n)).toBe(4);
  });

  it("hotels: 大型（extra 12分）・is_blocked・仮登録（area/location null）の例が入っている", async () => {
    const rows = await sql<
      { name: string; extra_minutes: number; is_blocked: boolean; area_id: string | null }[]
    >`select name, extra_minutes, is_blocked, area_id from hotels`;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.some((r) => r.extra_minutes >= 10 && !r.is_blocked)).toBe(true); // 大型
    expect(rows.some((r) => r.is_blocked)).toBe(true); // 入館お断り
    expect(rows.some((r) => r.area_id === null)).toBe(true); // 仮登録
  });

  it("hotels の予測入力（spec 8-2: 1〜2文字の前方一致で絞れる）", async () => {
    const rows = await sql<{ name: string }[]>`
      select name from hotels where name like '渋谷%' or name_kana like 'しぶ%'
    `;
    expect(rows.map((r) => r.name)).toEqual(["渋谷ステイイン"]);
  });
});

describe("★完了条件: ホテルの館内移動時間が加算される（spec 8-2・5-2）", () => {
  it("DB の extra_minutes（大型ホテル12分）が到着バッファに加算され、住居より総到着時間が増える", async () => {
    const hotel = await sql<{ extra_minutes: number }[]>`
      select extra_minutes from hotels where name = 'グランドタワーホテル東京'
    `;
    expect(hotel[0]?.extra_minutes).toBe(12);

    const defaults = await defaultBuffers();
    const toResidence = arrivalBuffers({
      mode: "car",
      defaults,
      destination: { kind: "residence" },
    });
    const toHotel = arrivalBuffers({
      mode: "car",
      defaults,
      destination: { kind: "hotel", hotelExtraMinutes: hotel[0]!.extra_minutes },
    });

    // 同一距離・同一バッファでも、ホテル行きだけ extra_minutes 分ぶん遅く着く
    expect(toHotel.arrivalTotalMin - toResidence.arrivalTotalMin).toBe(12);
    expect(toResidence.arrivalTotalMin).toBe(10 + 15); // 既定: 到着前10 + 駐車15
    expect(toHotel.arrivalTotalMin).toBe(10 + 15 + 12);
  });

  it("extra_minutes=0（仮登録ホテル）は住居と同じ総到着時間（増えない）", async () => {
    const hotel = await sql<{ extra_minutes: number }[]>`
      select extra_minutes from hotels where name = '（仮登録）中野ビジネスホテル'
    `;
    expect(hotel[0]?.extra_minutes).toBe(0);

    const defaults = await defaultBuffers();
    const toResidence = arrivalBuffers({ mode: "car", defaults, destination: { kind: "residence" } });
    const toHotel = arrivalBuffers({
      mode: "car",
      defaults,
      destination: { kind: "hotel", hotelExtraMinutes: hotel[0]!.extra_minutes },
    });
    expect(toHotel.arrivalTotalMin).toBe(toResidence.arrivalTotalMin);
  });

  it("is_blocked のホテルは予約対象外・通常ホテルは予約可（spec 15章）", async () => {
    const rows = await sql<{ name: string; is_blocked: boolean }[]>`
      select name, is_blocked from hotels
      where name in ('ホテルノワール新宿', '渋谷ステイイン')
    `;
    const blocked = rows.find((r) => r.name === "ホテルノワール新宿");
    const normal = rows.find((r) => r.name === "渋谷ステイイン");
    expect(isHotelBookable({ isBlocked: blocked!.is_blocked })).toBe(false);
    expect(isHotelBookable({ isBlocked: normal!.is_blocked })).toBe(true);
  });
});

describe("オプション duration_min が施術時間 L に効く（spec 3-4・5-3。DB 値で検証）", () => {
  it("スタンダード90 + 延長30 + ヘッドケア = L 135分（コース時間ではなく合計）", async () => {
    const course = await sql<{ duration_min: number; price: number }[]>`
      select duration_min, price from courses where name = 'スタンダード'
    `;
    const opts = await sql<{ duration_min: number; price: number }[]>`
      select duration_min, price from options where name in ('延長30分', 'ヘッドケア')
      order by sort_order
    `;
    const selected = opts.map((o) => ({ durationMin: o.duration_min, price: o.price }));
    expect(totalServiceMinutes(course[0]!.duration_min, selected)).toBe(135);
    // 金額合計（整数の円）: 17,000 + 6,000 + 2,500 = 25,500
    expect(
      totalPrice({ coursePrice: course[0]!.price, selectedOptions: selected }),
    ).toBe(25500);
  });

  it("duration_min=0 のオプション（アロマ）は L を変えない", async () => {
    const course = await sql<{ duration_min: number }[]>`
      select duration_min from courses where name = 'ショート'
    `;
    const aroma = await sql<{ duration_min: number }[]>`
      select duration_min from options where name = 'アロマオイル'
    `;
    expect(
      totalServiceMinutes(course[0]!.duration_min, [{ durationMin: aroma[0]!.duration_min }]),
    ).toBe(60);
  });
});

describe("courses / options / hotels の RLS（actor 別 / docs/auth-rls.md §4）", () => {
  it("reception は courses を select できるが insert できない", async () => {
    const visible = await withUser(sql, sessionOf("reception"), async (tx) => {
      return tx<{ id: string }[]>`select id from courses`;
    });
    expect(visible.length).toBe(4);

    await expect(
      withUser(sql, sessionOf("reception"), async (tx) => {
        await tx`insert into courses (name, duration_min, price) values ('侵入コース', 60, 1)`;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("therapist は options を select できるが update は 0 行（不可視）", async () => {
    const visible = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`select id from options`;
    });
    expect(visible.length).toBe(5);

    const updated = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`
        update options set price = 1 returning id
      `;
    });
    expect(updated.length).toBe(0);
  });

  it("admin は hotels（CMS 管理対象）を更新できる / therapist は select のみ", async () => {
    // 後片付けは finally で必ず走らせる（途中 expect が落ちてもシード値を汚さない）
    try {
      await withUser(sql, sessionOf("admin"), async (tx) => {
        const rows = await tx<{ id: string }[]>`
          update hotels set extra_minutes = 15
          where name = 'グランドタワーホテル東京' returning id
        `;
        expect(rows.length).toBe(1);
      });
    } finally {
      // 後片付け（保守経路 = BYPASSRLS）でシード値へ戻す
      await sql`update hotels set extra_minutes = 12 where name = 'グランドタワーホテル東京'`;
    }

    const asTherapist = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`select id from hotels`;
    });
    expect(asTherapist.length).toBeGreaterThanOrEqual(4);

    const updatedByTherapist = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`
        update hotels set is_blocked = false returning id
      `;
    });
    expect(updatedByTherapist.length).toBe(0);
  });

  it("owner は option_availability を書ける / reception は select のみ", async () => {
    const optionRows = await sql<{ id: string }[]>`select id from options where name = 'ヘッドケア'`;
    const therapistRows = await sql<{ id: string }[]>`select id from therapists where slug = 'minato'`;
    const optionId = optionRows[0]!.id;
    const therapistId = therapistRows[0]!.id;

    try {
      await withUser(sql, sessionOf("owner"), async (tx) => {
        await tx`
          insert into option_availability (option_id, therapist_id)
          values (${optionId}::uuid, ${therapistId}::uuid)
          on conflict (option_id, therapist_id) do nothing
        `;
      });
    } finally {
      // 後片付け（保守経路）: シード状態（フットケアのみ）へ戻す
      await sql`
        delete from option_availability
        where option_id = ${optionId}::uuid and therapist_id = ${therapistId}::uuid
      `;
    }

    await expect(
      withUser(sql, sessionOf("reception"), async (tx) => {
        await tx`
          insert into option_availability (option_id, therapist_id)
          values (${optionId}::uuid, ${therapistId}::uuid)
        `;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("withUser を通らない app_runtime 接続（GUC なし）では courses/hotels が見えない = fail-closed", async () => {
    const visible = await sql.begin(async (tx) => {
      await tx`select set_config('role', 'app_runtime', true)`;
      const cs = await tx<{ id: string }[]>`select id from courses`;
      const hs = await tx<{ id: string }[]>`select id from hotels`;
      return cs.length + hs.length;
    });
    expect(visible).toBe(0);
  });
});
