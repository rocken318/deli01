import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import type { Role } from "@/domain/auth";
import { addDaysISO, localDateISO } from "@/domain/availability";
import { listDailySchedule, listScheduleAreas } from "@/lib/schedule/queries";

/**
 * フェーズ8の統合テスト（実 Postgres / spec 3-3・2-3・15章・14章 #8）。
 *
 * 検証の骨子:
 * - 完了条件「エリアで絞れる」: /schedule の元クエリ listDailySchedule が
 *   area 指定で結果を変える。**出勤していても対応エリア外なら一覧に出ない**
 *   （spec 15章。aoi は渋谷対応・八王子非対応のシード配置）
 * - published のみ: minato は出勤していても未公開なので出ない
 * - 当日欠勤（is_day_off）は出ない
 * - 「60秒以内に反映」: force-dynamic + 毎リクエスト読取のため、更新が次の
 *   クエリで即座に反映されることを is_day_off の切替で実証する
 * - RLS: therapist は自分の shift のみ select/update（当日欠勤ワンタップ）、
 *   insert/delete 不可。reception は select のみ。withUser なしは fail-closed
 * - enable+force の網羅は auth-rls.test.ts の pg_class 走査が新テーブルも検査する
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const seedUsers = new Map<Role, { id: string }>();
const areaIds = new Map<string, string>();
const therapistIds = new Map<string, string>();

const today = localDateISO(new Date());
const dayOffDate = addDaysISO(today, 2); // シードで ren が当日欠勤の日

function sessionOf(role: Role): Session {
  const u = seedUsers.get(role);
  if (!u) throw new Error(`seed に ${role} のテストアカウントがない`);
  return { userId: u.id, role };
}

function areaOf(name: string): string {
  const id = areaIds.get(name);
  if (!id) throw new Error(`seed に エリア「${name}」がない`);
  return id;
}

function therapistOf(slug: string): string {
  const id = therapistIds.get(slug);
  if (!id) throw new Error(`seed に セラピスト「${slug}」がない`);
  return id;
}

beforeAll(async () => {
  const users = await sql<{ id: string; role: Role }[]>`
    select id, role from app_users where display_name like '（ダミー）%'
  `;
  for (const r of users) seedUsers.set(r.role, { id: r.id });

  const areas = await sql<{ id: string; name: string }[]>`select id, name from areas`;
  for (const a of areas) areaIds.set(a.name, a.id);

  const therapists = await sql<{ id: string; slug: string }[]>`select id, slug from therapists`;
  for (const t of therapists) therapistIds.set(t.slug, t.id);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("シードの検証（spec 3-3・18章 / フェーズ8）", () => {
  it("今日の shifts に aoi・ren・minato の予定がある", async () => {
    const rows = await sql<{ slug: string; is_day_off: boolean }[]>`
      select t.slug, s.is_day_off
      from shifts s join therapists t on t.id = s.therapist_id
      where s.work_date = ${today}
    `;
    const slugs = rows.map((r) => r.slug).sort();
    expect(slugs).toEqual(expect.arrayContaining(["aoi", "minato", "ren"]));
  });

  it("+2日は ren が当日欠勤（is_day_off = true）", async () => {
    const rows = await sql<{ is_day_off: boolean }[]>`
      select s.is_day_off from shifts s
      join therapists t on t.id = s.therapist_id
      where t.slug = 'ren' and s.work_date = ${dayOffDate}
    `;
    expect(rows[0]?.is_day_off).toBe(true);
  });

  it("セラピスト個人の移動設定: aoi は車不可、ren は車可（spec 5-1）", async () => {
    const rows = await sql<{ slug: string; can_use_car: boolean; walk_cap_meters: number | null }[]>`
      select slug, can_use_car, walk_cap_meters from therapists where slug in ('aoi', 'ren')
    `;
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    expect(bySlug.get("aoi")?.can_use_car).toBe(false);
    expect(bySlug.get("ren")?.can_use_car).toBe(true);
    // walk_cap_meters は null = walk_settings の既定を使う
    expect(bySlug.get("aoi")?.walk_cap_meters).toBeNull();
  });

  it("ダミー therapist アカウントが aoi に紐付いている（RLS 前提）", async () => {
    const rows = await sql<{ therapist_id: string | null }[]>`
      select therapist_id from app_users where role = 'therapist' and display_name like '（ダミー）%'
    `;
    expect(rows[0]?.therapist_id).toBe(therapistOf("aoi"));
  });
});

describe("日別の派遣可能一覧（完了条件: エリアで絞れる / spec 15章）", () => {
  it("エリア未指定: published + active + 非欠勤のセラピストが出る（minato は未公開なので出ない）", async () => {
    const entries = await listDailySchedule(today);
    const slugs = entries.map((e) => e.slug);
    expect(slugs).toContain("aoi");
    expect(slugs).toContain("ren");
    expect(slugs).not.toContain("minato"); // 出勤しているが published が無い
    expect(slugs).not.toContain("hinata"); // 退職
  });

  it("aoi の行: 出勤時間帯・上限本数・対応エリア（渋谷・恵比寿・目黒のみ）を持つ", async () => {
    const entries = await listDailySchedule(today);
    const aoi = entries.find((e) => e.slug === "aoi");
    expect(aoi).toBeDefined();
    expect(aoi?.maxBookings).toBe(3);
    expect(aoi?.startAt).toBeInstanceOf(Date);
    const areaNames = (aoi?.areas ?? []).map((a) => a.name).sort();
    expect(areaNames).toEqual(["恵比寿駅", "渋谷区", "目黒区"].sort());
  });

  it("渋谷区で絞ると aoi と ren が出る", async () => {
    const entries = await listDailySchedule(today, areaOf("渋谷区"));
    const slugs = entries.map((e) => e.slug);
    expect(slugs).toContain("aoi");
    expect(slugs).toContain("ren");
  });

  it("★ 八王子市で絞ると ren だけ。aoi は出勤していても対応エリア外なので出ない", async () => {
    const entries = await listDailySchedule(today, areaOf("八王子市"));
    const slugs = entries.map((e) => e.slug);
    expect(slugs).toContain("ren"); // 全域対応
    expect(slugs).not.toContain("aoi"); // 出勤中だがエリア外（spec 15章）
  });

  it("当日欠勤の日（+2日）: ren が一覧から消え、aoi は残る", async () => {
    const entries = await listDailySchedule(dayOffDate);
    const slugs = entries.map((e) => e.slug);
    expect(slugs).toContain("aoi");
    expect(slugs).not.toContain("ren"); // is_day_off = true
  });

  it("更新が即時に反映される（60秒以内どころか次のクエリで反映）", async () => {
    const aoiId = therapistOf("aoi");
    try {
      await sql`
        update shifts set is_day_off = true
        where therapist_id = ${aoiId}::uuid and work_date = ${today}
      `;
      const entries = await listDailySchedule(today);
      expect(entries.map((e) => e.slug)).not.toContain("aoi");
    } finally {
      await sql`
        update shifts set is_day_off = false
        where therapist_id = ${aoiId}::uuid and work_date = ${today}
      `;
    }
    const restored = await listDailySchedule(today);
    expect(restored.map((e) => e.slug)).toContain("aoi");
  });

  it("不正な日付は空を返す", async () => {
    expect(await listDailySchedule("2026-8-1")).toEqual([]);
    expect(await listDailySchedule("not-a-date")).toEqual([]);
  });

  it("listScheduleAreas は is_active のエリアを sort_order 順で返す", async () => {
    const areas = await listScheduleAreas();
    expect(areas.length).toBeGreaterThanOrEqual(10);
    expect(areas.map((a) => a.name)).toContain("渋谷区");
    expect(areas.map((a) => a.name)).toContain("八王子市");
  });
});

describe("shifts / shift_areas の RLS（docs/auth-rls.md §4 の actor 別）", () => {
  it("therapist は自分（aoi）の shift だけ見える", async () => {
    const aoiId = therapistOf("aoi");
    const visible = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ therapist_id: string }[]>`select therapist_id from shifts`;
    });
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((r) => r.therapist_id === aoiId)).toBe(true);
  });

  it("therapist は自分の shift を更新できる（当日欠勤ワンタップ / spec 3-3）", async () => {
    const aoiId = therapistOf("aoi");
    try {
      const updated = await withUser(sql, sessionOf("therapist"), async (tx) => {
        return tx<{ id: string }[]>`
          update shifts set is_day_off = true
          where therapist_id = ${aoiId}::uuid and work_date = ${today}
          returning id
        `;
      });
      expect(updated.length).toBe(1);
    } finally {
      await sql`
        update shifts set is_day_off = false
        where therapist_id = ${therapistOf("aoi")}::uuid and work_date = ${today}
      `;
    }
  });

  it("therapist は他人（ren）の shift を更新できない（0行）", async () => {
    const renId = therapistOf("ren");
    const updated = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`
        update shifts set is_day_off = true
        where therapist_id = ${renId}::uuid and work_date = ${today}
        returning id
      `;
    });
    expect(updated.length).toBe(0);
    // 素の接続（BYPASSRLS）で実際に変わっていないことも確認
    const rows = await sql<{ is_day_off: boolean }[]>`
      select is_day_off from shifts
      where therapist_id = ${renId}::uuid and work_date = ${today}
    `;
    expect(rows[0]?.is_day_off).toBe(false);
  });

  it("therapist は shift を作成できない（insert ポリシーなし = RLS 拒否）", async () => {
    const aoiId = therapistOf("aoi");
    await expect(
      withUser(sql, sessionOf("therapist"), async (tx) => {
        await tx`
          insert into shifts (therapist_id, work_date, start_at, end_at)
          values (${aoiId}::uuid, '2099-01-01', '2099-01-01T01:00:00Z', '2099-01-01T10:00:00Z')
        `;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("therapist は shift_areas も自分の shift の行だけ見える", async () => {
    const aoiId = therapistOf("aoi");
    const visible = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ shift_id: string }[]>`select shift_id from shift_areas`;
    });
    expect(visible.length).toBeGreaterThan(0);
    const ownShiftIds = await sql<{ id: string }[]>`
      select id from shifts where therapist_id = ${aoiId}::uuid
    `;
    const own = new Set(ownShiftIds.map((r) => r.id));
    expect(visible.every((r) => own.has(r.shift_id))).toBe(true);
  });

  it("reception は select できるが insert はできない", async () => {
    const visible = await withUser(sql, sessionOf("reception"), async (tx) => {
      return tx<{ id: string }[]>`select id from shifts`;
    });
    expect(visible.length).toBeGreaterThan(0);

    await expect(
      withUser(sql, sessionOf("reception"), async (tx) => {
        await tx`
          insert into shifts (therapist_id, work_date, start_at, end_at)
          values (${therapistOf("aoi")}::uuid, '2099-01-02', '2099-01-02T01:00:00Z', '2099-01-02T10:00:00Z')
        `;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("owner は shift を作成・削除できる（出勤設定画面の経路）", async () => {
    const aoiId = therapistOf("aoi");
    const created = await withUser(sql, sessionOf("owner"), async (tx) => {
      return tx<{ id: string }[]>`
        insert into shifts (therapist_id, work_date, start_at, end_at, max_bookings)
        values (${aoiId}::uuid, '2099-01-03', '2099-01-03T01:00:00Z', '2099-01-03T10:00:00Z', 2)
        returning id
      `;
    });
    expect(created.length).toBe(1);
    const shiftId = created[0]!.id;

    const deleted = await withUser(sql, sessionOf("owner"), async (tx) => {
      return tx<{ id: string }[]>`
        delete from shifts where id = ${shiftId}::uuid returning id
      `;
    });
    expect(deleted.length).toBe(1);
  });

  it("withUser を通らない app_runtime（GUC なし）では何も見えない = fail-closed", async () => {
    const visible = await sql.begin(async (tx) => {
      await tx`select set_config('role', 'app_runtime', true)`;
      return tx<{ id: string }[]>`select id from shifts`;
    });
    expect((visible as { id: string }[]).length).toBe(0);
  });
});
