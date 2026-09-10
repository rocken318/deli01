# 配車表 フェーズ3（ドライバー週次シフト）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** ドライバーの週次シフト（曜日×時間・25時超え可）を登録できるようにする。稼働チェック↔時間欄の連動、**前週コピー**、**消すまで翌週へ引き継ぐシフトメモ**、**当日出勤ドライバー抽出**（配車ボードが後で使う）を実装する。

**Architecture:** 週の境界・時刻分換算・曜日は純関数（`src/domain/dispatch/driver-shifts.ts`・TDD）。`driver_shift_weeks`/`driver_shift_days`（マイグレーション0032）＋ Server Actions（週取得/保存/前週コピー/当日出勤抽出）＋統合テスト。UI はフェーズ2の `DriversClient` に週次シフト節を追加。

**Tech Stack:** Next.js 15 / TS strict / postgres.js / RLS / Zod / date-fns-tz（`Asia/Tokyo`）/ Vitest（統合は実 Postgres）。設計 4.3。UI 参考 `.superpowers/brainstorm/1464-1789071838/content/reg-drivers-v6.html`（週次シフト＋シフトメモ節）。

---

## 前提
- 最新マイグレーション = `0031_drivers.sql` → 本フェーズ **`0032_driver_shifts.sql`**。
- 週は**月曜始まり**。時刻は「当日00:00からの分」（25時超え可・例 27:00=1620）。
- `set_updated_at()` は既存。seed 固定 UUID: reception=`aaaaaaaa-0000-4000-8000-000000000003`。統合テストは自前で drivers 行を作って後片付けする（`ztest-drivers.test.ts` 同様）。
- `src/domain/dispatch/` は既存フォルダ。純関数はここに置き `.test.ts` を同居。

## File Structure
- Create `migrations/0032_driver_shifts.sql`
- Create `src/domain/dispatch/driver-shifts.ts`（純関数）＋ `src/domain/dispatch/driver-shifts.test.ts`
- Create `src/lib/drivers/shift-actions.ts`（Server Actions）＋ `tests/integration/ztest-driver-shifts.test.ts`
- Modify `src/app/(admin)/admin/drivers/DriversClient.tsx`（週次シフト節を追加）

---

## Task 1: マイグレーション 0032

**Files:** Create `migrations/0032_driver_shifts.sql`

- [ ] **Step 1: 作成**

```sql
-- 0032_driver_shifts: ドライバー週次シフト（設計 4.3）。
-- 週=月曜始まり。時刻は当日00:00からの分（25時超え可＝1440超を許容）。
-- memo は「消すまで翌週へ引き継ぐシフトメモ」（引継ぎはアプリ層で解決）。
-- RLS: 参照 = owner/admin/reception、書込 = owner/admin。

create table if not exists driver_shift_weeks (
  id          uuid primary key default gen_random_uuid(),
  driver_id   uuid not null references drivers (id) on delete cascade,
  week_start  date not null,          -- 月曜
  memo        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint driver_shift_weeks_uniq unique (driver_id, week_start)
);

create table if not exists driver_shift_days (
  id         uuid primary key default gen_random_uuid(),
  week_id    uuid not null references driver_shift_weeks (id) on delete cascade,
  dow        smallint not null,       -- 0=月 .. 6=日
  start_min  int not null,            -- 当日0:00からの分（0..2879）
  end_min    int not null,
  constraint driver_shift_days_dow_check check (dow between 0 and 6),
  constraint driver_shift_days_min_check check (start_min >= 0 and end_min > start_min and end_min <= 2879),
  constraint driver_shift_days_uniq unique (week_id, dow)
);

create index if not exists driver_shift_days_week_idx on driver_shift_days (week_id);

drop trigger if exists driver_shift_weeks_set_updated_at on driver_shift_weeks;
create trigger driver_shift_weeks_set_updated_at
  before update on driver_shift_weeks
  for each row execute function set_updated_at();

alter table driver_shift_weeks enable row level security;
alter table driver_shift_weeks force row level security;
alter table driver_shift_days  enable row level security;
alter table driver_shift_days  force row level security;

drop policy if exists driver_shift_weeks_read on driver_shift_weeks;
create policy driver_shift_weeks_read on driver_shift_weeks
  for select using (app_current_role() in ('owner','admin','reception'));
drop policy if exists driver_shift_weeks_write on driver_shift_weeks;
create policy driver_shift_weeks_write on driver_shift_weeks
  for all using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

drop policy if exists driver_shift_days_read on driver_shift_days;
create policy driver_shift_days_read on driver_shift_days
  for select using (app_current_role() in ('owner','admin','reception'));
drop policy if exists driver_shift_days_write on driver_shift_days;
create policy driver_shift_days_write on driver_shift_days
  for all using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

grant select, insert, update, delete on driver_shift_weeks to app_runtime;
grant select, insert, update, delete on driver_shift_days  to app_runtime;
```

- [ ] **Step 2:** Run `pnpm db:migrate` → `適用: 0032_driver_shifts.sql`。
- [ ] **Step 3:** `git add migrations/0032_driver_shifts.sql && git commit -m "feat(dispatch): driver_shift_weeks/days（週次シフト）マスタを追加"`

---

## Task 2: 週ロジックの純関数（TDD）

**Files:** Create `src/domain/dispatch/driver-shifts.ts`, `src/domain/dispatch/driver-shifts.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `src/domain/dispatch/driver-shifts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mondayOf, dowOfDate, parseDayTime, formatDayTime } from "./driver-shifts";

describe("mondayOf", () => {
  it("水曜(2026-09-16)の週開始は月曜 2026-09-14", () => {
    expect(mondayOf("2026-09-16")).toBe("2026-09-14");
  });
  it("月曜はその日自身", () => {
    expect(mondayOf("2026-09-14")).toBe("2026-09-14");
  });
  it("日曜(2026-09-20)の週開始は 2026-09-14", () => {
    expect(mondayOf("2026-09-20")).toBe("2026-09-14");
  });
});

describe("dowOfDate（0=月..6=日）", () => {
  it("月曜=0", () => expect(dowOfDate("2026-09-14")).toBe(0));
  it("日曜=6", () => expect(dowOfDate("2026-09-20")).toBe(6));
});

describe("parseDayTime / formatDayTime（25時超え）", () => {
  it("'27:00' → 1620", () => expect(parseDayTime("27:00")).toBe(1620));
  it("'9:30' → 570", () => expect(parseDayTime("9:30")).toBe(570));
  it("不正は null", () => {
    expect(parseDayTime("black")).toBeNull();
    expect(parseDayTime("12:60")).toBeNull();
    expect(parseDayTime("")).toBeNull();
  });
  it("1620 → '27:00'（ゼロ埋め）", () => expect(formatDayTime(1620)).toBe("27:00"));
  it("570 → '09:30'", () => expect(formatDayTime(570)).toBe("09:30"));
});
```

- [ ] **Step 2:** Run `pnpm test -- src/domain/dispatch/driver-shifts.test.ts` → FAIL（module not found）。

- [ ] **Step 3: 実装**

Create `src/domain/dispatch/driver-shifts.ts`:

```ts
/**
 * ドライバー週次シフトの純関数（設計 4.3）。
 * 週=月曜始まり。時刻は当日0:00からの分（25時超え可）。
 * 日付は "YYYY-MM-DD"（Asia/Tokyo の暦日）を UTC 正午基準で扱い、DST の無い JST で安全。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toUtcNoon(dateISO: string): Date {
  // JST は DST 無し。正午を使い日跨ぎ丸め誤差を避ける。
  return new Date(`${dateISO}T12:00:00Z`);
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** dateISO を含む週（月曜始まり）の月曜を返す。 */
export function mondayOf(dateISO: string): string {
  if (!DATE_RE.test(dateISO)) throw new RangeError(`bad date: ${dateISO}`);
  const d = toUtcNoon(dateISO);
  const jsDow = d.getUTCDay(); // 0=日..6=土
  const backToMon = (jsDow + 6) % 7; // 月曜まで戻す日数
  d.setUTCDate(d.getUTCDate() - backToMon);
  return fmt(d);
}

/** 0=月 .. 6=日 */
export function dowOfDate(dateISO: string): number {
  if (!DATE_RE.test(dateISO)) throw new RangeError(`bad date: ${dateISO}`);
  const jsDow = toUtcNoon(dateISO).getUTCDay();
  return (jsDow + 6) % 7;
}

/** "HH:MM"（時は0..47）→ 当日0:00からの分。不正は null。 */
export function parseDayTime(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 47 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 分 → "HH:MM"（時は2桁ゼロ埋め・25時超え可）。 */
export function formatDayTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
```

- [ ] **Step 4:** Run `pnpm test -- src/domain/dispatch/driver-shifts.test.ts` → PASS（全件）。
- [ ] **Step 5:** `git add src/domain/dispatch/driver-shifts.ts src/domain/dispatch/driver-shifts.test.ts && git commit -m "feat(dispatch): 週次シフトの純関数（週境界/時刻分換算/曜日）"`

---

## Task 3: シフト Server Actions ＋ 統合テスト（TDD）

**Files:** Create `src/lib/drivers/shift-actions.ts`, `tests/integration/ztest-driver-shifts.test.ts`

仕様:
- `getDriverWeek(driverId, weekStartISO)`: その週の行があれば days＋memo を返す。無ければ **memo は直近の過去週から引き継ぎ**（days は空）。
- `saveDriverWeek(driverId, weekStartISO, days, memo)`: week 行を upsert（memo 更新）→ その週の days を全削除→再挿入（トランザクション）。
- `copyPreviousWeek(driverId, weekStartISO)`: 直近の過去週（week_start < 対象）の days＋memo を対象週へ複製。過去週が無ければ `ok:false, error:'前週のシフトがありません'`。
- `listActiveDriversForDate(dateISO)`: `mondayOf`＋`dowOfDate` で当日稼働（その曜日に days を持つ）ドライバーを返す（配車ボードの右レール用）。

- [ ] **Step 1: 失敗するテストを書く**

Create `tests/integration/ztest-driver-shifts.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  getDriverWeek,
  saveDriverWeek,
  copyPreviousWeek,
  listActiveDriversForDate,
} from "@/lib/drivers/shift-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let driverId: string;

beforeAll(async () => {
  const rows = await sql<{ id: string }[]>`
    insert into drivers (name, vehicle_color_hex, vehicle_color_name)
    values ('シフトテスト運転手', '#123456', 'テスト色') returning id
  `;
  driverId = rows[0]!.id;
});

afterAll(async () => {
  await sql`delete from drivers where id = ${driverId}::uuid`; // cascade で週/日も消える
  await sql.end({ timeout: 5 });
});

const W1 = "2026-09-07"; // 月曜
const W2 = "2026-09-14"; // 翌週 月曜

describe("saveDriverWeek / getDriverWeek", () => {
  it("保存した曜日とメモを取得できる", async () => {
    const save = await saveDriverWeek({
      driverId,
      weekStart: W1,
      memo: "車検 9/23",
      days: [
        { dow: 0, start: "11:00", end: "23:00" },
        { dow: 5, start: "20:00", end: "27:00" }, // 土 25時超え
      ],
    });
    expect(save.ok).toBe(true);

    const got = await getDriverWeek(driverId, W1);
    expect(got.ok).toBe(true);
    expect(got.data?.memo).toBe("車検 9/23");
    const sat = got.data?.days.find((d) => d.dow === 5);
    expect(sat?.start).toBe("20:00");
    expect(sat?.end).toBe("27:00");
  });

  it("翌週はメモを引き継ぐ（days は空）", async () => {
    const got = await getDriverWeek(driverId, W2);
    expect(got.ok).toBe(true);
    expect(got.data?.memo).toBe("車検 9/23");
    expect(got.data?.days.length).toBe(0);
  });
});

describe("copyPreviousWeek", () => {
  it("前週の曜日とメモを複製する", async () => {
    const r = await copyPreviousWeek(driverId, W2);
    expect(r.ok).toBe(true);
    const got = await getDriverWeek(driverId, W2);
    expect(got.data?.days.length).toBe(2);
    expect(got.data?.memo).toBe("車検 9/23");
  });
});

describe("listActiveDriversForDate", () => {
  it("稼働曜日（月=2026-09-07）に当該ドライバーが出る", async () => {
    const r = await listActiveDriversForDate("2026-09-07");
    expect(r.ok).toBe(true);
    const found = r.data?.find((d) => d.id === driverId);
    expect(found).toBeDefined();
    expect(found?.start).toBe("11:00");
  });
  it("非稼働曜日（火=2026-09-08）には出ない", async () => {
    const r = await listActiveDriversForDate("2026-09-08");
    const found = r.data?.find((d) => d.id === driverId);
    expect(found).toBeUndefined();
  });
});
```

- [ ] **Step 2:** Run `pnpm test -- tests/integration/ztest-driver-shifts.test.ts` → FAIL（module not found）。

- [ ] **Step 3: 実装**

Create `src/lib/drivers/shift-actions.ts`:

```ts
'use server';

/**
 * ドライバー週次シフト Server Actions（設計 4.3）。
 * 参照 = manage_reservations、書込 = manage_cms。時刻は純関数で分換算。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import {
  mondayOf, dowOfDate, parseDayTime, formatDayTime,
} from '@/domain/dispatch/driver-shifts';

export interface ActionResult<T = void> { ok: boolean; data?: T; error?: string; }

export interface ShiftDay { dow: number; start: string; end: string; }
export interface DriverWeek { weekStart: string; memo: string; days: ShiftDay[]; }
export interface ActiveDriver {
  id: string; name: string; vehicleColorHex: string | null;
  vehicleColorName: string | null; vehicleNumber: string | null; start: string; end: string;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const saveSchema = z.object({
  driverId: z.string().uuid(),
  weekStart: DATE,
  memo: z.string().max(2000).optional(),
  days: z.array(z.object({
    dow: z.number().int().min(0).max(6),
    start: z.string(),
    end: z.string(),
  })).max(7),
});

export async function getDriverWeek(driverId: string, weekStartISO: string): Promise<ActionResult<DriverWeek>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!DATE.safeParse(weekStartISO).success) return { ok: false, error: '日付が不正です' };
  const weekStart = mondayOf(weekStartISO);
  const sql = getClient();
  try {
    return await withUser(sql, session, async (tx) => {
      const weeks = await tx<{ id: string; memo: string | null }[]>`
        select id, memo from driver_shift_weeks
        where driver_id = ${driverId}::uuid and week_start = ${weekStart}::date
      `;
      if (weeks[0]) {
        const days = await tx<{ dow: number; start_min: number; end_min: number }[]>`
          select dow, start_min, end_min from driver_shift_days
          where week_id = ${weeks[0].id}::uuid order by dow asc
        `;
        return { ok: true, data: {
          weekStart, memo: weeks[0].memo ?? '',
          days: days.map((d) => ({ dow: d.dow, start: formatDayTime(d.start_min), end: formatDayTime(d.end_min) })),
        } };
      }
      // 引き継ぎ: 直近の過去週の memo
      const prior = await tx<{ memo: string | null }[]>`
        select memo from driver_shift_weeks
        where driver_id = ${driverId}::uuid and week_start < ${weekStart}::date
        order by week_start desc limit 1
      `;
      return { ok: true, data: { weekStart, memo: prior[0]?.memo ?? '', days: [] } };
    });
  } catch (e) {
    console.error('getDriverWeek failed:', e);
    return { ok: false, error: 'シフトの取得に失敗しました' };
  }
}

export async function saveDriverWeek(input: z.input<typeof saveSchema>): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  const d = parsed.data;
  const weekStart = mondayOf(d.weekStart);
  // 時刻を分へ。不正/逆転は弾く。
  const days: { dow: number; startMin: number; endMin: number }[] = [];
  for (const day of d.days) {
    const s = parseDayTime(day.start); const e = parseDayTime(day.end);
    if (s === null || e === null || e <= s) return { ok: false, error: `曜日${day.dow}の時刻が不正です` };
    days.push({ dow: day.dow, startMin: s, endMin: e });
  }
  const sql = getClient();
  try {
    await withUser(sql, session, async (tx) => {
      const w = await tx<{ id: string }[]>`
        insert into driver_shift_weeks (driver_id, week_start, memo)
        values (${d.driverId}::uuid, ${weekStart}::date, ${d.memo ?? null})
        on conflict (driver_id, week_start) do update set memo = excluded.memo
        returning id
      `;
      const weekId = w[0]!.id;
      await tx`delete from driver_shift_days where week_id = ${weekId}::uuid`;
      for (const day of days) {
        await tx`
          insert into driver_shift_days (week_id, dow, start_min, end_min)
          values (${weekId}::uuid, ${day.dow}, ${day.startMin}, ${day.endMin})
        `;
      }
    });
    revalidatePath('/admin/drivers');
    return { ok: true };
  } catch (e) {
    console.error('saveDriverWeek failed:', e);
    return { ok: false, error: 'シフトの保存に失敗しました' };
  }
}

export async function copyPreviousWeek(driverId: string, weekStartISO: string): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_cms')) return { ok: false, error: 'この操作はオーナー/管理者のみ実行できます' };
  if (!z.string().uuid().safeParse(driverId).success) return { ok: false, error: 'IDが不正です' };
  if (!DATE.safeParse(weekStartISO).success) return { ok: false, error: '日付が不正です' };
  const weekStart = mondayOf(weekStartISO);
  const sql = getClient();
  try {
    const prior = await withUser(sql, session, async (tx) => {
      const w = await tx<{ id: string; memo: string | null }[]>`
        select id, memo from driver_shift_weeks
        where driver_id = ${driverId}::uuid and week_start < ${weekStart}::date
        order by week_start desc limit 1
      `;
      if (!w[0]) return null;
      const days = await tx<{ dow: number; start_min: number; end_min: number }[]>`
        select dow, start_min, end_min from driver_shift_days where week_id = ${w[0].id}::uuid
      `;
      return { memo: w[0].memo, days };
    });
    if (!prior) return { ok: false, error: '前週のシフトがありません' };
    return await saveDriverWeek({
      driverId, weekStart,
      memo: prior.memo ?? undefined,
      days: prior.days.map((d) => ({ dow: d.dow, start: formatDayTime(d.start_min), end: formatDayTime(d.end_min) })),
    });
  } catch (e) {
    console.error('copyPreviousWeek failed:', e);
    return { ok: false, error: '前週コピーに失敗しました' };
  }
}

export async function listActiveDriversForDate(dateISO: string): Promise<ActionResult<ActiveDriver[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!DATE.safeParse(dateISO).success) return { ok: false, error: '日付が不正です' };
  const weekStart = mondayOf(dateISO);
  const dow = dowOfDate(dateISO);
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string; name: string; vehicle_color_hex: string | null;
        vehicle_color_name: string | null; vehicle_number: string | null;
        start_min: number; end_min: number;
      }[]>`
        select dr.id, dr.name, dr.vehicle_color_hex, dr.vehicle_color_name, dr.vehicle_number,
               dsd.start_min, dsd.end_min
        from drivers dr
        join driver_shift_weeks dsw on dsw.driver_id = dr.id and dsw.week_start = ${weekStart}::date
        join driver_shift_days  dsd on dsd.week_id = dsw.id and dsd.dow = ${dow}
        where dr.is_active = true
        order by dsd.start_min asc, dr.sort_order asc, dr.name asc
      `;
    });
    return { ok: true, data: rows.map((r) => ({
      id: r.id, name: r.name, vehicleColorHex: r.vehicle_color_hex,
      vehicleColorName: r.vehicle_color_name, vehicleNumber: r.vehicle_number,
      start: formatDayTime(r.start_min), end: formatDayTime(r.end_min),
    })) };
  } catch (e) {
    console.error('listActiveDriversForDate failed:', e);
    return { ok: false, error: '当日出勤ドライバーの取得に失敗しました' };
  }
}
```

- [ ] **Step 4:** Run `pnpm test -- tests/integration/ztest-driver-shifts.test.ts` → PASS（6 件）。
- [ ] **Step 5:** `git add src/lib/drivers/shift-actions.ts tests/integration/ztest-driver-shifts.test.ts && git commit -m "feat(dispatch): 週次シフトの取得/保存/前週コピー/当日出勤抽出＋統合テスト"`

---

## Task 4: DriversClient に週次シフト節を追加

**Files:** Modify `src/app/(admin)/admin/drivers/DriversClient.tsx`

参考 `.superpowers/brainstorm/1464-1789071838/content/reg-drivers-v6.html` の週次シフト＋シフトメモ節。要件:
- ドライバー選択（編集）中のみ表示。週セレクタ（◀ 週開始 ▶・`mondayOf` で正規化・既定は当日を含む週）＋「⧉ 前週をコピー（メモも一緒に）」ボタン。
- 曜日表（月〜日）: 稼働チェック ON→開始/終了の入力（"HH:MM"・27:00 可）、OFF→「休み」。連動は client state。
- **シフトメモ** テキストエリア（黄色枠・「翌週へ自動引き継ぎ」表示）。
- 週切替時に `getDriverWeek(driverId, weekStart)` を呼び days/memo をロード（メモ引継ぎはサーバが解決）。保存で `saveDriverWeek`。前週コピーで `copyPreviousWeek`→再ロード。
- 新規作成（未保存ドライバー）中はシフト節を出さない（先にドライバー保存が必要な旨を表示）。
- 時刻換算は表示のみクライアントで行い、保存は "HH:MM" 文字列を渡す（サーバが `parseDayTime`）。`any` 禁止。

- [ ] **Step 1:** 上記要件で `DriversClient.tsx` に節を追加（既存フォーム構造を壊さない）。
- [ ] **Step 2:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/drivers/DriversClient.tsx" && git commit -m "feat(dispatch): ドライバー登録に週次シフト（稼働連動/前週コピー/メモ引継ぎ）"`

---

## Task 5: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（driver-shifts 純関数 + ztest-driver-shifts 6 込み）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 設計4.3 の週次シフト/メモ引継ぎ/前週コピー/当日出勤抽出＝Task1-3、UI＝Task4。全項目に対応タスクあり。
- Placeholder: 純関数/actions/test は完全コード。UI は既存 `DriversClient` 拡張＋要件明示＋モック参照。
- 型整合: `ShiftDay{dow,start,end}`/`DriverWeek{weekStart,memo,days}`/`ActiveDriver`/`getDriverWeek`/`saveDriverWeek`/`copyPreviousWeek`/`listActiveDriversForDate` を test/UI が一致使用。純関数 `mondayOf/dowOfDate/parseDayTime/formatDayTime` を actions が使用。
- 注意: `listActiveDriversForDate` は次フェーズ（配車ボード右レール）で使う。本フェーズでは関数＋テストのみ。
