# 配車表 フェーズ4（配車ボード再設計）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** 配車ボードを「送り車／帰り車の2脚＋手動状態＋色分け＋終了（アーカイブ）」へ再設計する。ドライバーはドラッグ&ドロップで割当（上書き）、状態はプルダウン（送り6/帰り4）、セル全面を状態色で塗る。右レールは当日出勤ドライバー（フェーズ3の `listActiveDriversForDate`）。予約の車要否フラグ・退勤送りはフェーズ5/6。

**Architecture:** 既存 `getDispatchBoardCore`（予約行）は壊さず、**脚（`dispatch_legs`）を additive に追加**。状態遷移候補は純関数（`leg-states.ts`・TDD）。脚の割当/状態/終了は Server Actions（実 Postgres 統合テスト）。ボード UI（`DispatchBoardClient`）を予約行＋送り/帰り脚セルへ再構築（モック v6 準拠）。

**Tech Stack:** Next.js 15 / TS strict / postgres.js / RLS / Zod / Vitest。設計 4.6・4.7・5.1。UI 参考 `.superpowers/brainstorm/1464-1789071838/content/board-redesign-v6.html`（**退勤送りセクションは除く**＝フェーズ6）。既存 UI: `src/app/(admin)/admin/dispatch-board/DispatchBoardClient.tsx`。

---

## 前提
- 最新マイグレーション = `0032_driver_shifts.sql` → 本フェーズ **`0033_dispatch_legs.sql`**。
- 既存 `getDispatchBoardCore`（`src/lib/dispatch-board/queries.ts`）と `getDispatchBoard`/`advanceReservationStatus`/`updateDispatchFields`（`.../actions.ts`）はそのまま活かす（ステータス前進・遅延/退出アラート・部屋/派遣先/時刻・メモ編集）。
- フェーズ3の `listActiveDriversForDate`（`src/lib/drivers/shift-actions.ts`）を右レールに使う。
- enum 作成は `do $$ ... create type ... $$` の冪等パターン（0016 参照）。
- seed 固定 UUID: reception=`aaaaaaaa-0000-4000-8000-000000000003`、aoi therapist=slug 'aoi'。統合テストは自前で予約/ドライバーを作り後片付け（`ztest-dispatch-ops.test.ts` の `insertReservationWithRoom` を参考にした自作ヘルパ可）。

## File Structure
- Create `migrations/0033_dispatch_legs.sql`
- Create `src/domain/dispatch/leg-states.ts` ＋ `.test.ts`
- Create `src/lib/dispatch-board/leg-actions.ts`（脚 CRUD＋当日脚取得）＋ `tests/integration/ztest-dispatch-legs.test.ts`
- Modify `src/app/(admin)/admin/dispatch-board/DispatchBoardClient.tsx`（送り/帰り脚セル・D&D・状態・終了・右レール）
- Modify `src/app/(admin)/admin/dispatch-board/page.tsx`（右レール用に当日出勤ドライバーと脚を渡す）

---

## Task 1: マイグレーション 0033（dispatch_legs）

**Files:** Create `migrations/0033_dispatch_legs.sql`

- [ ] **Step 1: 作成**

```sql
-- 0033_dispatch_legs: 配車の脚（送り車/帰り車/退勤送り）。設計 4.6。
-- 予約配車は reservation_id + kind(reservation_send/reservation_return) で最大2脚。
-- 退勤送り(send_home)はフェーズ6で使用（本フェーズでは型のみ用意）。
-- state は種別ごとに候補が異なる（アプリ層で検証）。
-- RLS: 参照/書込 = owner/admin/reception（manage_reservations 相当）。

do $$
begin
  if not exists (select 1 from pg_type where typname = 'dispatch_leg_kind') then
    create type dispatch_leg_kind as enum
      ('reservation_send', 'reservation_return', 'send_home');
  end if;
end $$;

create table if not exists dispatch_legs (
  id               uuid primary key default gen_random_uuid(),
  brand_id         uuid not null default 'cccccccc-0000-4000-9000-000000000001'
                     references brands (id) on delete restrict,
  kind             dispatch_leg_kind not null,
  reservation_id   uuid references reservations (id) on delete cascade,
  therapist_id     uuid references therapists (id) on delete set null,
  work_date        date not null,
  driver_id        uuid references drivers (id) on delete set null,
  state            text not null default '予定',
  depart_at        timestamptz,
  destination_text text,
  round_trip_min   int,
  memo             text,
  is_finished      bool not null default false,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- 予約脚は (予約, 種別) につき1脚
  constraint dispatch_legs_reservation_kind_uniq
    unique (reservation_id, kind)
);

create index if not exists dispatch_legs_workdate_idx on dispatch_legs (work_date);
create index if not exists dispatch_legs_reservation_idx on dispatch_legs (reservation_id);

drop trigger if exists dispatch_legs_set_updated_at on dispatch_legs;
create trigger dispatch_legs_set_updated_at
  before update on dispatch_legs
  for each row execute function set_updated_at();

alter table dispatch_legs enable row level security;
alter table dispatch_legs force row level security;

drop policy if exists dispatch_legs_staff_all on dispatch_legs;
create policy dispatch_legs_staff_all on dispatch_legs
  for all
  using (app_current_role() in ('owner','admin','reception'))
  with check (app_current_role() in ('owner','admin','reception'));

grant select, insert, update, delete on dispatch_legs to app_runtime;
```

- [ ] **Step 2:** Run `pnpm db:migrate` → `適用: 0033_dispatch_legs.sql`。
- [ ] **Step 3:** `git add migrations/0033_dispatch_legs.sql && git commit -m "feat(dispatch): dispatch_legs（送り車/帰り車/退勤送りの脚）を追加"`

---

## Task 2: 状態の純関数（TDD）

**Files:** Create `src/domain/dispatch/leg-states.ts`, `.test.ts`

- [ ] **Step 1: 失敗するテスト**

Create `src/domain/dispatch/leg-states.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  SEND_STATES, RETURN_STATES, statesForSlot, initialStateForSlot,
  isValidState, isDoneState, kindForSlot,
} from "./leg-states";

describe("leg-states", () => {
  it("送りは6状態・この順", () => {
    expect(SEND_STATES).toEqual(["予定","送り中","合流確認中","インコール待機中","バック中","完了"]);
  });
  it("帰りは4状態・この順", () => {
    expect(RETURN_STATES).toEqual(["向かい中","アウト待ち","バック中","完了"]);
  });
  it("初期状態: 送り=予定 / 帰り=向かい中", () => {
    expect(initialStateForSlot("send")).toBe("予定");
    expect(initialStateForSlot("return")).toBe("向かい中");
  });
  it("statesForSlot", () => {
    expect(statesForSlot("send")).toEqual(SEND_STATES);
    expect(statesForSlot("return")).toEqual(RETURN_STATES);
  });
  it("isValidState", () => {
    expect(isValidState("send", "合流確認中")).toBe(true);
    expect(isValidState("send", "アウト待ち")).toBe(false);
    expect(isValidState("return", "アウト待ち")).toBe(true);
  });
  it("isDoneState", () => {
    expect(isDoneState("完了")).toBe(true);
    expect(isDoneState("送り中")).toBe(false);
  });
  it("kindForSlot", () => {
    expect(kindForSlot("send")).toBe("reservation_send");
    expect(kindForSlot("return")).toBe("reservation_return");
  });
});
```

- [ ] **Step 2:** Run `pnpm test -- src/domain/dispatch/leg-states.test.ts` → FAIL。

- [ ] **Step 3: 実装**

Create `src/domain/dispatch/leg-states.ts`:

```ts
/**
 * 配車脚の状態候補（設計 4.7）。手動更新・種別ごとに候補が異なる。
 * 送り: 予定→送り中→合流確認中→インコール待機中→バック中→完了
 * 帰り: 向かい中→アウト待ち→バック中→完了
 */
export const SEND_STATES = [
  "予定", "送り中", "合流確認中", "インコール待機中", "バック中", "完了",
] as const;
export const RETURN_STATES = [
  "向かい中", "アウト待ち", "バック中", "完了",
] as const;

export type LegSlot = "send" | "return";

export function statesForSlot(slot: LegSlot): readonly string[] {
  return slot === "send" ? SEND_STATES : RETURN_STATES;
}
export function initialStateForSlot(slot: LegSlot): string {
  return slot === "send" ? "予定" : "向かい中";
}
export function isValidState(slot: LegSlot, state: string): boolean {
  return statesForSlot(slot).includes(state);
}
export function isDoneState(state: string): boolean {
  return state === "完了";
}
export function kindForSlot(slot: LegSlot): "reservation_send" | "reservation_return" {
  return slot === "send" ? "reservation_send" : "reservation_return";
}
```

- [ ] **Step 4:** Run `pnpm test -- src/domain/dispatch/leg-states.test.ts` → PASS。
- [ ] **Step 5:** `git add src/domain/dispatch/leg-states.ts src/domain/dispatch/leg-states.test.ts && git commit -m "feat(dispatch): 配車脚の状態候補（純関数）"`

---

## Task 3: 脚 Server Actions ＋ 統合テスト（TDD）

**Files:** Create `src/lib/dispatch-board/leg-actions.ts`, `tests/integration/ztest-dispatch-legs.test.ts`

仕様（すべて manage_reservations = owner/admin/reception）:
- `assignLegDriver({ reservationId, slot, driverId })`: `(reservation_id, kind)` で脚を upsert。driver をセットし **state を初期化**（送り=予定/帰り=向かい中）＝D&D 上書き。`work_date`・`therapist_id` は予約から解決。
- `setLegState({ legId, slot, state })`: `isValidState(slot,state)` 検証後 update。
- `clearLegDriver({ legId })`: driver_id を null に。
- `finishReservation({ reservationId })`: その予約の全脚が state='完了' の時のみ is_finished=true・finished_at=now。1脚も無ければ error。
- `getDispatchLegs(dateISO, includeFinished=false)`: 当日の予約脚を `{ reservationId, send: LegView|null, return: LegView|null, allFinished: boolean }[]` で返す。`includeFinished=false` なら allFinished の予約を除外。LegView = `{ id, driverId, driverName, vehicleColorHex, vehicleColorName, vehicleNumber, state, isFinished }`。

- [ ] **Step 1: 失敗するテスト**

Create `tests/integration/ztest-dispatch-legs.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  assignLegDriver, setLegState, clearLegDriver, finishReservation, getDispatchLegs,
} from "@/lib/dispatch-board/leg-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

let aoiId: string, driverId: string, resId: string, resDate: string;

async function insertReservation(offsetMin: number): Promise<string> {
  const id = randomUUID();
  const startMs = Date.now() + offsetMin * 60_000;
  const start = new Date(startMs), end = new Date(startMs + 3_600_000);
  const depart = new Date(startMs - 1_200_000), free = new Date(startMs + 4_800_000);
  await sql`
    insert into reservations (
      id, therapist_id, course_id, start_at, end_at, depart_at, free_at,
      travel_in_min, travel_out_min, buffer_min, status, total_amount
    ) values (
      ${id}::uuid, ${aoiId}::uuid, (select id from courses limit 1),
      ${start}, ${end}, ${depart}, ${free}, 15, 15, 5, 'confirmed'::reservation_status, 10000
    ) on conflict (id) do nothing`;
  return id;
}

beforeAll(async () => {
  aoiId = (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id;
  driverId = (await sql<{ id: string }[]>`
    insert into drivers (name, vehicle_color_hex, vehicle_color_name, vehicle_number)
    values ('脚テスト運転手','#2B2B2B','黒','6417') returning id`)[0]!.id;
  resId = await insertReservation(120);
  resDate = formatInTimeZone(
    (await sql<{ start_at: Date }[]>`select start_at from reservations where id=${resId}::uuid`)[0]!.start_at,
    "Asia/Tokyo", "yyyy-MM-dd");
});

afterAll(async () => {
  await sql`delete from dispatch_legs where reservation_id = ${resId}::uuid`;
  await sql`delete from reservations where id = ${resId}::uuid`;
  await sql`delete from drivers where id = ${driverId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("assignLegDriver / getDispatchLegs", () => {
  it("送り脚にドライバーを割当（state=予定）", async () => {
    const r = await assignLegDriver({ reservationId: resId, slot: "send", driverId });
    expect(r.ok).toBe(true);
    const legs = await getDispatchLegs(resDate);
    const row = legs.data?.find((x) => x.reservationId === resId);
    expect(row?.send?.driverId).toBe(driverId);
    expect(row?.send?.state).toBe("予定");
    expect(row?.send?.vehicleColorHex).toBe("#2B2B2B");
  });

  it("再割当は上書き＋state初期化", async () => {
    await setLegState({
      legId: (await getDispatchLegs(resDate)).data!.find((x) => x.reservationId === resId)!.send!.id,
      slot: "send", state: "合流確認中",
    });
    await assignLegDriver({ reservationId: resId, slot: "send", driverId });
    const legs = await getDispatchLegs(resDate);
    expect(legs.data?.find((x) => x.reservationId === resId)?.send?.state).toBe("予定");
  });
});

describe("setLegState 検証", () => {
  it("帰り脚に送り状態はエラー", async () => {
    await assignLegDriver({ reservationId: resId, slot: "return", driverId });
    const legId = (await getDispatchLegs(resDate)).data!.find((x) => x.reservationId === resId)!.return!.id;
    const bad = await setLegState({ legId, slot: "return", state: "合流確認中" });
    expect(bad.ok).toBe(false);
    const good = await setLegState({ legId, slot: "return", state: "アウト待ち" });
    expect(good.ok).toBe(true);
  });
});

describe("finishReservation", () => {
  it("全脚完了で終了→includeFinished=false で消える", async () => {
    const legs = (await getDispatchLegs(resDate)).data!.find((x) => x.reservationId === resId)!;
    await setLegState({ legId: legs.send!.id, slot: "send", state: "完了" });
    await setLegState({ legId: legs.return!.id, slot: "return", state: "完了" });
    const fin = await finishReservation({ reservationId: resId });
    expect(fin.ok).toBe(true);
    const hidden = await getDispatchLegs(resDate);
    expect(hidden.data?.find((x) => x.reservationId === resId)).toBeUndefined();
    const shown = await getDispatchLegs(resDate, true);
    expect(shown.data?.find((x) => x.reservationId === resId)?.allFinished).toBe(true);
  });
});

describe("clearLegDriver", () => {
  it("割当解除で driverId が null", async () => {
    const res2 = await (async () => {
      const id = await insertReservation(180);
      return id;
    })();
    await assignLegDriver({ reservationId: res2, slot: "send", driverId });
    const legId = (await getDispatchLegs(resDate, true)).data!.find((x) => x.reservationId === res2)!.send!.id;
    const r = await clearLegDriver({ legId });
    expect(r.ok).toBe(true);
    const after = (await getDispatchLegs(resDate, true)).data!.find((x) => x.reservationId === res2);
    expect(after?.send?.driverId ?? null).toBeNull();
    await sql`delete from dispatch_legs where reservation_id = ${res2}::uuid`;
    await sql`delete from reservations where id = ${res2}::uuid`;
  });
});
```

- [ ] **Step 2:** Run `pnpm test -- tests/integration/ztest-dispatch-legs.test.ts` → FAIL（module not found）。

- [ ] **Step 3: 実装**

Create `src/lib/dispatch-board/leg-actions.ts`（`taxi`/`drivers` actions のパターン。純関数 `leg-states` を使用）:

```ts
'use server';

/**
 * 配車脚（送り車/帰り車）の割当・状態・終了・当日取得（設計 4.6/4.7）。
 * 権限: manage_reservations（owner/admin/reception）。
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { addDays } from 'date-fns';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { withUser } from '@/lib/auth/with-user';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import {
  initialStateForSlot, isValidState, isDoneState, kindForSlot, type LegSlot,
} from '@/domain/dispatch/leg-states';

const APP_TZ = 'Asia/Tokyo';
export interface ActionResult<T = void> { ok: boolean; data?: T; error?: string; }

export interface LegView {
  id: string; driverId: string | null; driverName: string | null;
  vehicleColorHex: string | null; vehicleColorName: string | null;
  vehicleNumber: string | null; state: string; isFinished: boolean;
}
export interface ReservationLegs {
  reservationId: string; send: LegView | null; return: LegView | null; allFinished: boolean;
}

const slotSchema = z.enum(['send', 'return']);
const DATE = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);

function revalidate() {
  revalidatePath('/admin/dispatch-board');
  revalidatePath('/admin/annai');
}

export async function assignLegDriver(input: {
  reservationId: string; slot: LegSlot; driverId: string;
}): Promise<ActionResult<{ legId: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  const parsed = z.object({
    reservationId: z.string().uuid(), slot: slotSchema, driverId: z.string().uuid(),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };
  const { reservationId, slot, driverId } = parsed.data;
  const kind = kindForSlot(slot);
  const initState = initialStateForSlot(slot);
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      const r = await tx<{ therapist_id: string; start_at: Date }[]>`
        select therapist_id, start_at from reservations where id = ${reservationId}::uuid`;
      if (!r[0]) return [];
      const workDate = formatInTimeZone(r[0].start_at, APP_TZ, 'yyyy-MM-dd');
      return tx<{ id: string }[]>`
        insert into dispatch_legs (kind, reservation_id, therapist_id, work_date, driver_id, state)
        values (${kind}::dispatch_leg_kind, ${reservationId}::uuid, ${r[0].therapist_id}::uuid,
                ${workDate}::date, ${driverId}::uuid, ${initState})
        on conflict (reservation_id, kind) do update
          set driver_id = excluded.driver_id, state = excluded.state, is_finished = false, finished_at = null
        returning id`;
    });
    if (!rows[0]) return { ok: false, error: '予約が見つかりません' };
    revalidate();
    return { ok: true, data: { legId: rows[0].id } };
  } catch (e) {
    console.error('assignLegDriver failed:', e);
    return { ok: false, error: 'ドライバー割当に失敗しました' };
  }
}

export async function setLegState(input: {
  legId: string; slot: LegSlot; state: string;
}): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  const parsed = z.object({
    legId: z.string().uuid(), slot: slotSchema, state: z.string(),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };
  if (!isValidState(parsed.data.slot, parsed.data.state)) {
    return { ok: false, error: 'この状態は選べません' };
  }
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update dispatch_legs set state = ${parsed.data.state}
        where id = ${parsed.data.legId}::uuid returning id`;
    });
    if (!rows[0]) return { ok: false, error: '脚が見つかりません' };
    revalidate();
    return { ok: true };
  } catch (e) {
    console.error('setLegState failed:', e);
    return { ok: false, error: '状態の更新に失敗しました' };
  }
}

export async function clearLegDriver(input: { legId: string }): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!z.string().uuid().safeParse(input.legId).success) return { ok: false, error: 'IDが不正です' };
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{ id: string }[]>`
        update dispatch_legs set driver_id = null where id = ${input.legId}::uuid returning id`;
    });
    if (!rows[0]) return { ok: false, error: '脚が見つかりません' };
    revalidate();
    return { ok: true };
  } catch (e) {
    console.error('clearLegDriver failed:', e);
    return { ok: false, error: '割当解除に失敗しました' };
  }
}

export async function finishReservation(input: { reservationId: string }): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!z.string().uuid().safeParse(input.reservationId).success) return { ok: false, error: 'IDが不正です' };
  const sql = getClient();
  try {
    const result = await withUser(sql, session, async (tx) => {
      const legs = await tx<{ id: string; state: string }[]>`
        select id, state from dispatch_legs
        where reservation_id = ${input.reservationId}::uuid and kind in ('reservation_send','reservation_return')`;
      if (legs.length === 0) return 'no_legs';
      if (!legs.every((l) => isDoneState(l.state))) return 'not_done';
      await tx`
        update dispatch_legs set is_finished = true, finished_at = now()
        where reservation_id = ${input.reservationId}::uuid and kind in ('reservation_send','reservation_return')`;
      return 'ok';
    });
    if (result === 'no_legs') return { ok: false, error: '配車がありません' };
    if (result === 'not_done') return { ok: false, error: '送り車・帰り車が完了していません' };
    revalidate();
    return { ok: true };
  } catch (e) {
    console.error('finishReservation failed:', e);
    return { ok: false, error: '終了処理に失敗しました' };
  }
}

export async function getDispatchLegs(
  dateISO: string, includeFinished = false,
): Promise<ActionResult<ReservationLegs[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  if (!can(toActor(session), 'manage_reservations')) return { ok: false, error: '運営権限が必要です' };
  if (!DATE.safeParse(dateISO).success) return { ok: false, error: '日付が不正です' };
  const dayStart = fromZonedTime(`${dateISO}T00:00:00`, APP_TZ);
  const dayEnd = addDays(dayStart, 1);
  const sql = getClient();
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<{
        id: string; kind: string; reservation_id: string; state: string; is_finished: boolean;
        driver_id: string | null; driver_name: string | null;
        vehicle_color_hex: string | null; vehicle_color_name: string | null; vehicle_number: string | null;
      }[]>`
        select l.id, l.kind::text, l.reservation_id, l.state, l.is_finished,
               l.driver_id, dr.name as driver_name,
               dr.vehicle_color_hex, dr.vehicle_color_name, dr.vehicle_number
        from dispatch_legs l
        left join drivers dr on dr.id = l.driver_id
        where l.work_date = ${dateISO}::date
          and l.kind in ('reservation_send','reservation_return')
          and l.reservation_id is not null`;
    });
    // dayStart/dayEnd は将来の跨ぎ対応の布石（現状 work_date で十分）。未使用回避のため参照。
    void dayStart; void dayEnd;
    const byRes = new Map<string, ReservationLegs>();
    for (const r of rows) {
      const key = r.reservation_id;
      const entry = byRes.get(key) ?? { reservationId: key, send: null, return: null, allFinished: false };
      const view: LegView = {
        id: r.id, driverId: r.driver_id, driverName: r.driver_name,
        vehicleColorHex: r.vehicle_color_hex, vehicleColorName: r.vehicle_color_name,
        vehicleNumber: r.vehicle_number, state: r.state, isFinished: r.is_finished,
      };
      if (r.kind === 'reservation_send') entry.send = view;
      else entry.return = view;
      byRes.set(key, entry);
    }
    const list: ReservationLegs[] = [];
    for (const entry of byRes.values()) {
      const legs = [entry.send, entry.return].filter((x): x is LegView => x !== null);
      entry.allFinished = legs.length > 0 && legs.every((l) => l.isFinished);
      if (!includeFinished && entry.allFinished) continue;
      list.push(entry);
    }
    return { ok: true, data: list };
  } catch (e) {
    console.error('getDispatchLegs failed:', e);
    return { ok: false, error: '配車脚の取得に失敗しました' };
  }
}
```

- [ ] **Step 4:** Run `pnpm test -- tests/integration/ztest-dispatch-legs.test.ts` → PASS。
- [ ] **Step 5:** `git add src/lib/dispatch-board/leg-actions.ts tests/integration/ztest-dispatch-legs.test.ts && git commit -m "feat(dispatch): 脚の割当/状態/終了/当日取得＋統合テスト"`

---

## Task 4: 配車ボード UI 再構築

**Files:** Modify `src/app/(admin)/admin/dispatch-board/page.tsx`, `.../DispatchBoardClient.tsx`

参考モック `.superpowers/brainstorm/1464-1789071838/content/board-redesign-v6.html`（**退勤送りセクションは除外**＝フェーズ6）。既存 `DispatchBoardClient.tsx` の遅延/退出アラート・日付ナビ・ステータス前進・部屋/派遣先/時刻表示は保持しつつ、以下へ再構築:

要件:
- **列**: 女性 / コース(分) / 派遣先(エリア+ホテル) / 部屋 / 出発 / IN / **送り車** / OUT / **帰り車** / メモ / 状態・終了。送り車=IN隣、帰り車=OUT隣。
- **送り車/帰り車セル**: 割当ドライバーを「氏名 車番+色名」で表示、セル全面を状態色で塗る（`leg-states` の状態→色マップは client 内定数）、左に車色帯（`vehicleColorHex`）。**状態プルダウン**（送り=SEND_STATES/帰り=RETURN_STATES）→ `setLegState`。未割当は点線ドロップゾーン。**LINE 2ボタン**（🚕運転手/👩女性）はプレースホルダ（onClick はフェーズ9で実装。今は disabled かトースト「準備中」）。
- **ドラッグ&ドロップ**: 右レールのドライバーチップを送り/帰りセルへドロップ → `assignLegDriver`（上書き）。HTML5 DnD（draggable + onDragStart で driverId を dataTransfer、セル onDrop）。既割当セルへのドロップも上書き。
- **右レール「本日出勤ドライバー」**: `listActiveDriversForDate(dateISO)` の結果（車色帯・氏名・車番）。page.tsx から初期データを渡し、日付変更時はクライアントで再取得（`listActiveDriversForDate` を action として import）。
- **終了ボタン**（状態列）: その予約の送り/帰り脚がすべて `完了` の時のみ活性→`finishReservation`→一覧から消える。上部トグル「終了分も表示」で `getDispatchLegs(date, true)` 相当に切替（脚 + board items 両方 includeFinished）。
- **脚データの取得**: page.tsx で `getDispatchBoard(date)`（既存・予約行）と `getDispatchLegs(date)`（脚）を両方取得し、クライアントで `reservationId` で突合。日付変更/更新時はクライアントで両方再取得。
- 既存の遅延/退出アラート・出発(実測/予定)・IN/OUT 実測時刻・空状態/ローディング/エラーの3状態は維持。`syncUrl` prop（案内表タブ埋込）も維持。
- 管理側日本語直書き可。`any` 禁止。色/状態マップは client 定数（モック v6 の配色）。

実装ヒント:
- 既存 `DispatchBoardClient` の props に `initialLegs: ReservationLegs[]` と `initialActiveDrivers: ActiveDriver[]` を追加。page.tsx で取得して渡す。
- `getDispatchLegs`・`listActiveDriversForDate`・`assignLegDriver`・`setLegState`・`clearLegDriver`・`finishReservation` を client から呼ぶ（全て 'use server'）。
- 旧 `dispatchDriver`/`dispatchMemo`（0024 自由文字列）は残置。メモ列は既存の `updateDispatchFields` を継続利用（脚とは別）。ドライバー欄は脚へ移行。

- [ ] **Step 1:** page.tsx を更新（`getDispatchLegs`・`listActiveDriversForDate` を取得し client へ渡す）。
- [ ] **Step 2:** DispatchBoardClient.tsx を上記要件で再構築。
- [ ] **Step 3:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 4:** `git add "src/app/(admin)/admin/dispatch-board" && git commit -m "feat(dispatch): 配車ボードを送り/帰り2脚＋D&D＋状態色＋終了へ再構築"`

---

## Task 5: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（leg-states 単体 + ztest-dispatch-legs 込み・**既存 dispatch-board/annai テストが赤くならないこと**）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 設計4.6（dispatch_legs）=Task1、4.7（状態）=Task2、脚割当/状態/終了/取得=Task3、5.1 ボード UI=Task4。退勤送り（send_home）は型のみ用意しフェーズ6で使用と明記。
- Placeholder: migration/純関数/actions/test は完全コード。UI は既存 client 拡張＋モック v6 参照＋詳細要件。LINE ボタンはプレースホルダと明記（フェーズ9）。
- 型整合: `LegSlot`/`SEND_STATES`/`RETURN_STATES`/`kindForSlot`/`isValidState`/`initialStateForSlot`/`isDoneState`（Task2）を Task3 が使用。`LegView`/`ReservationLegs`/`assignLegDriver`/`setLegState`/`clearLegDriver`/`finishReservation`/`getDispatchLegs`（Task3）を Task4 UI が使用。既存 `getDispatchBoard`/`DispatchBoardItem` は不変。
- リスク: 既存 `getDispatchBoardCore` は変更しない（additive）。既存テスト非破壊を Task5 で担保。
