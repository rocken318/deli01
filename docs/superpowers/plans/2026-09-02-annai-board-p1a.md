# 案内表ボード P1a（読み取りビュー）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 統合コンソールの「案内表タブ」の読み取りビュー＝全セラピストを「次案内可能が早い順」に並べ、各行に 終わった仕事(左)・次案内可能ウィンドウ(中央固定)・これからの仕事(右) を表示する（予約作成・清算は後続 P1b/P2）。

**Architecture:** 純関数 `computeAvailableWindow`（次案内可能の開始/上限/空き分を算出）＋`buildBoard`（ウィンドウ計算＋早い順ソート＋上がり分離）を DB 非依存で実装。RLS 下のクエリ `listAnnaiBoardCore` が per-therapist の当日 done/upcoming/shift/attendance を集約。サーバコンポーネント `/admin/annai` が v13 レイアウトで描画。当日データは seed-demo の当日タイムラインで検証。

**Tech Stack:** Next.js 15 App Router / postgres.js + RLS(withUser) / date-fns-tz / Vitest（統合は実Postgres）。

設計: `docs/superpowers/specs/2026-09-02-annai-console-design.md`。

## 型・シグネチャ契約（全タスク共通）

`src/domain/annai/window.ts`:
```
export interface JobItem { id: string; startAt: Date; endAt: Date; departAt: Date; freeAt: Date; totalAmount: number; status: string }
export type AttendanceState = "off" | "working" | "done";
export interface BoardInput {
  therapistId: string; slug: string; name: string;
  attendanceState: AttendanceState;
  shiftStart: Date | null; shiftEnd: Date | null;
  lateManual: boolean;
  done: JobItem[];      // 当日の done 予約（時刻昇順）
  upcoming: JobItem[];  // 当日の confirmed/enroute/in_service（時刻昇順）
}
export interface AvailWindow { kind: "now" | "from" | "off" | "done"; fromMs: number | null; untilMs: number | null; gapMin: number | null }
export interface BoardRow extends BoardInput { window: AvailWindow }
export const DEFAULT_BUFFERS = { afterBufferMin: 30, travelMin: 15 } as const;
export function computeAvailableWindow(row: BoardInput, nowMs: number, buffers?: { afterBufferMin: number; travelMin: number }): AvailWindow
export function buildBoard(rows: BoardInput[], nowMs: number, buffers?: { afterBufferMin: number; travelMin: number }): { active: BoardRow[]; retired: BoardRow[] }
```

`src/lib/annai/queries.ts`:
```
export async function listAnnaiBoardCore(tx: TransactionSql, nowMs: number): Promise<BoardInput[]>
```

JST 稼働日は `formatInTimeZone(new Date(nowMs), "Asia/Tokyo", "yyyy-MM-dd")`。

---

## File Structure
- Create `src/domain/annai/window.ts` / `window.test.ts` — 次案内可能ウィンドウ＋ボード組み立て（純関数）
- Create `src/domain/annai/index.ts` — re-export
- Create `src/lib/annai/queries.ts` — RLS 下の当日集約クエリ
- Create `tests/integration/annai-board-p1a.test.ts` — 実Postgres（seed-demo 当日タイムライン前提）
- Create `src/app/(admin)/admin/annai/page.tsx` — 板の読み取りビュー（v13 レイアウト）

---

### Task 1: computeAvailableWindow（純関数）

**Files:**
- Create: `src/domain/annai/window.ts`
- Test: `src/domain/annai/window.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/domain/annai/window.test.ts
import { describe, expect, it } from "vitest";
import { computeAvailableWindow, type BoardInput, type JobItem } from "./window";

const at = (h: number, m = 0) => new Date(2026, 8, 1, h, m, 0);
const job = (sh: number, eh: number, extra: Partial<JobItem> = {}): JobItem => ({
  id: `${sh}`, startAt: at(sh), endAt: at(eh), departAt: at(sh, -25), freeAt: at(eh, 10),
  totalAmount: 13000, status: "done", ...extra,
});
const base: BoardInput = {
  therapistId: "t", slug: "yuna", name: "ゆな", attendanceState: "working",
  shiftStart: at(11), shiftEnd: at(23), lateManual: false, done: [], upcoming: [],
};

describe("computeAvailableWindow", () => {
  it("出勤中・予約なし → 今すぐ・上限は shiftEnd まで", () => {
    const w = computeAvailableWindow(base, at(16).getTime());
    expect(w.kind).toBe("now");
    expect(w.fromMs).toBeNull(); // now 以下＝今すぐ
    expect(w.untilMs).toBe(at(23).getTime());
  });

  it("done×2 の後 → 最後の終了+30+移動15 から、上限は次予約の出発", () => {
    const row: BoardInput = {
      ...base,
      done: [job(11, 12), job(14, 15)],
      upcoming: [job(18, 19, { status: "confirmed", departAt: at(17, 35) })],
    };
    const w = computeAvailableWindow(row, at(15, 20).getTime());
    // 最後の終了15:00 + 30 + 15 = 15:45
    expect(w.fromMs).toBe(at(15, 45).getTime());
    expect(w.untilMs).toBe(at(17, 35).getTime());
    expect(w.gapMin).toBe(110); // 15:45→17:35
    expect(w.kind).toBe("from");
  });

  it("退勤済 → done", () => {
    const w = computeAvailableWindow({ ...base, attendanceState: "done" }, at(23).getTime());
    expect(w.kind).toBe("done");
  });

  it("未出勤(off) → off", () => {
    const w = computeAvailableWindow({ ...base, attendanceState: "off", shiftStart: null }, at(16).getTime());
    expect(w.kind).toBe("off");
  });

  it("未出勤だが shift あり → 出勤予定+移動の見込み(from)", () => {
    const w = computeAvailableWindow({ ...base, attendanceState: "off" }, at(9).getTime());
    expect(w.kind).toBe("from");
    expect(w.fromMs).toBe(at(11, 15).getTime()); // shiftStart 11:00 + travel15
  });
});
```

- [ ] **Step 2: 落ちる確認**

Run: `pnpm test src/domain/annai/window.test.ts`
Expected: FAIL（`./window` 未実装）。

- [ ] **Step 3: 実装**

```ts
// src/domain/annai/window.ts
export interface JobItem {
  id: string; startAt: Date; endAt: Date; departAt: Date; freeAt: Date; totalAmount: number; status: string;
}
export type AttendanceState = "off" | "working" | "done";
export interface BoardInput {
  therapistId: string; slug: string; name: string;
  attendanceState: AttendanceState;
  shiftStart: Date | null; shiftEnd: Date | null;
  lateManual: boolean;
  done: JobItem[];
  upcoming: JobItem[];
}
export interface AvailWindow {
  kind: "now" | "from" | "off" | "done";
  fromMs: number | null;   // null = 今すぐ（now 以下）
  untilMs: number | null;  // null = 上限なし
  gapMin: number | null;
}
export interface BoardRow extends BoardInput { window: AvailWindow }

export const DEFAULT_BUFFERS = { afterBufferMin: 30, travelMin: 15 } as const;
const MIN = 60_000;

export function computeAvailableWindow(
  row: BoardInput,
  nowMs: number,
  buffers: { afterBufferMin: number; travelMin: number } = DEFAULT_BUFFERS,
): AvailWindow {
  if (row.attendanceState === "done") return { kind: "done", fromMs: null, untilMs: null, gapMin: null };

  const extraMs = (buffers.afterBufferMin + buffers.travelMin) * MIN;

  // 未出勤: shift があれば見込み、無ければ off
  let baseFromMs: number;
  if (row.attendanceState === "off") {
    if (!row.shiftStart) return { kind: "off", fromMs: null, untilMs: null, gapMin: null };
    baseFromMs = row.shiftStart.getTime() + buffers.travelMin * MIN;
  } else {
    // 出勤中: 直近に始まった予約（開始<=now）の施術終了 + バッファ + 移動
    const started = [...row.done, ...row.upcoming].filter((j) => j.startAt.getTime() <= nowMs);
    const lastEnd = started.length ? Math.max(...started.map((j) => j.endAt.getTime())) : null;
    baseFromMs = lastEnd !== null ? Math.max(nowMs, lastEnd + extraMs) : nowMs;
  }

  // 上限 = baseFrom より後に出発する次予約の depart_at（無ければ shiftEnd）
  const nextDepart = row.upcoming
    .map((j) => j.departAt.getTime())
    .filter((d) => d > baseFromMs)
    .sort((a, b) => a - b)[0];
  const untilMs = nextDepart ?? row.shiftEnd?.getTime() ?? null;

  const isNow = baseFromMs <= nowMs;
  const gapMin = untilMs !== null ? Math.round((untilMs - baseFromMs) / MIN) : null;

  return {
    kind: isNow && row.attendanceState === "working" ? "now" : "from",
    fromMs: isNow ? null : baseFromMs,
    untilMs,
    gapMin,
  };
}

/** ウィンドウ計算＋「次案内可能が早い順」ソート。done は retired に分離。 */
export function buildBoard(
  rows: BoardInput[],
  nowMs: number,
  buffers: { afterBufferMin: number; travelMin: number } = DEFAULT_BUFFERS,
): { active: BoardRow[]; retired: BoardRow[] } {
  const withWin: BoardRow[] = rows.map((r) => ({ ...r, window: computeAvailableWindow(r, nowMs, buffers) }));
  const retired = withWin.filter((r) => r.window.kind === "done");
  const active = withWin
    .filter((r) => r.window.kind !== "done" && r.window.kind !== "off")
    .sort((a, b) => sortKey(a, nowMs) - sortKey(b, nowMs));
  return { active, retired };
}

function sortKey(r: BoardRow, nowMs: number): number {
  // 今すぐ(fromMs=null) は最優先＝now、それ以外は fromMs
  return r.window.fromMs ?? nowMs;
}
```

- [ ] **Step 4: 通る確認**

Run: `pnpm test src/domain/annai/window.test.ts`
Expected: PASS（5件）。

- [ ] **Step 5: index.ts**

```ts
// src/domain/annai/index.ts
export {
  computeAvailableWindow, buildBoard, DEFAULT_BUFFERS,
} from "./window";
export type { JobItem, AttendanceState, BoardInput, AvailWindow, BoardRow } from "./window";
```

- [ ] **Step 6: Commit**

```bash
git add src/domain/annai/
git commit -m "feat(annai): computeAvailableWindow + buildBoard (pure) + tests"
```

---

### Task 2: buildBoard のソート/分離テスト（追加）

**Files:**
- Test: `src/domain/annai/window.test.ts`（追記）

- [ ] **Step 1: テスト追記**

`window.test.ts` の末尾（最後の `});` の後）に追記：

```ts
import { buildBoard } from "./window";

describe("buildBoard", () => {
  const mk = (slug: string, state: "working" | "done", done: JobItem[] = [], upcoming: JobItem[] = []): BoardInput => ({
    therapistId: slug, slug, name: slug, attendanceState: state,
    shiftStart: at(11), shiftEnd: at(23), lateManual: false, done, upcoming,
  });
  it("今すぐの子が上、上がりは retired に分離", () => {
    const now = at(16).getTime();
    const ren = mk("ren", "working"); // 予約なし=今すぐ
    const yuna = mk("yuna", "working", [job(11, 12), job(14, 15)], [job(18, 19, { status: "confirmed", departAt: at(17, 35) })]); // 15:45〜
    const kohar = mk("kohar", "done");
    const { active, retired } = buildBoard([yuna, ren, kohar], now);
    expect(active.map((r) => r.slug)).toEqual(["ren", "yuna"]); // 今すぐ→15:45
    expect(retired.map((r) => r.slug)).toEqual(["kohar"]);
  });
});
```

- [ ] **Step 2: 通る確認**

Run: `pnpm test src/domain/annai/window.test.ts`
Expected: PASS（6件）。

- [ ] **Step 3: Commit**

```bash
git add src/domain/annai/window.test.ts
git commit -m "test(annai): buildBoard sort + retired separation"
```

---

### Task 3: listAnnaiBoardCore（RLSクエリ）＋統合テスト

**Files:**
- Create: `src/lib/annai/queries.ts`
- Test: `tests/integration/annai-board-p1a.test.ts`

- [ ] **Step 1: 失敗する統合テストを書く**

```ts
// tests/integration/annai-board-p1a.test.ts
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { listAnnaiBoardCore } from "@/lib/annai/queries";
import { buildBoard } from "@/domain/annai";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });
const OWNER: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "owner" };

afterAll(async () => { await sql.end(); });

describe("annai board (実Postgres・seed-demo 当日タイムライン前提)", () => {
  it("yuna の当日 done×2 / upcoming×2 が集約される", async () => {
    // 前提: pnpm db:seed:demo 済（yuna/mei/rin に当日 done×2+confirmed×2）
    const nowMs = Date.now();
    const rows = await withUser(sql, OWNER, (tx) => listAnnaiBoardCore(tx, nowMs));
    const yuna = rows.find((r) => r.slug === "yuna");
    expect(yuna).toBeTruthy();
    expect(yuna!.done.length).toBeGreaterThanOrEqual(2);
    expect(yuna!.upcoming.length).toBeGreaterThanOrEqual(2);
    // ソート・ウィンドウ計算が落ちない
    const { active } = buildBoard(rows, nowMs);
    expect(Array.isArray(active)).toBe(true);
  });

  it("行は名前・slug・状態を持つ", async () => {
    const rows = await withUser(sql, OWNER, (tx) => listAnnaiBoardCore(tx, Date.now()));
    for (const r of rows) {
      expect(typeof r.slug).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(["off", "working", "done"]).toContain(r.attendanceState);
    }
  });
});
```

- [ ] **Step 2: 落ちる確認**

Run: `pnpm test tests/integration/annai-board-p1a.test.ts`
Expected: FAIL（`@/lib/annai/queries` 未実装）。

- [ ] **Step 3: 実装**

```ts
// src/lib/annai/queries.ts
import "server-only";
import type { TransactionSql } from "postgres";
import { formatInTimeZone } from "date-fns-tz";
import type { BoardInput, JobItem, AttendanceState } from "@/domain/annai";

const TZ = "Asia/Tokyo";

interface ResRow {
  therapist_id: string; slug: string; name: string | null;
  clock_in_at: Date | null; clock_out_at: Date | null;
  shift_start: Date | null; shift_end: Date | null;
  res_id: string | null; status: string | null;
  start_at: Date | null; end_at: Date | null; depart_at: Date | null; free_at: Date | null; total_amount: number | null;
}

/**
 * 当日（JST）の全 active セラピストについて、shift/attendance と
 * done/upcoming 予約を集約して BoardInput[] を返す。RLS 下で呼ぶこと。
 */
export async function listAnnaiBoardCore(tx: TransactionSql, nowMs: number): Promise<BoardInput[]> {
  const wd = formatInTimeZone(new Date(nowMs), TZ, "yyyy-MM-dd");
  const rows = await tx<ResRow[]>`
    select
      t.id as therapist_id, t.slug as slug, (er.draft ->> 'name') as name,
      a.clock_in_at, a.clock_out_at,
      s.start_at as shift_start, s.end_at as shift_end,
      r.id as res_id, r.status::text as status,
      r.start_at, r.end_at, r.depart_at, r.free_at, r.total_amount
    from therapists t
    left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
    left join attendances a on a.therapist_id = t.id and a.work_date = ${wd}
    left join shifts s on s.therapist_id = t.id and s.work_date = ${wd} and s.is_day_off = false
    left join reservations r
      on r.therapist_id = t.id
     and (r.start_at at time zone ${TZ})::date = ${wd}::date
     and r.status in ('confirmed','enroute','in_service','done')
    where t.status = 'active'
    order by t.display_order, r.start_at nulls last
  `;

  const byTherapist = new Map<string, BoardInput>();
  for (const row of rows) {
    let b = byTherapist.get(row.therapist_id);
    if (!b) {
      const state: AttendanceState = row.clock_out_at
        ? "done"
        : row.clock_in_at || row.shift_start
          ? "working"
          : "off";
      b = {
        therapistId: row.therapist_id,
        slug: row.slug,
        name: row.name ?? row.slug,
        attendanceState: state,
        shiftStart: row.shift_start,
        shiftEnd: row.shift_end,
        lateManual: false,
        done: [],
        upcoming: [],
      };
      byTherapist.set(row.therapist_id, b);
    }
    if (row.res_id && row.start_at && row.end_at && row.depart_at && row.free_at) {
      const job: JobItem = {
        id: row.res_id,
        startAt: row.start_at,
        endAt: row.end_at,
        departAt: row.depart_at,
        freeAt: row.free_at,
        totalAmount: row.total_amount ?? 0,
        status: row.status ?? "",
      };
      if (row.status === "done") b.done.push(job);
      else b.upcoming.push(job);
    }
  }
  // 当日 実績も予定も予約も無い（off かつ shift 無し）は板に出さない
  return [...byTherapist.values()].filter((b) => b.attendanceState !== "off" || b.done.length || b.upcoming.length);
}
```

> 実装前に `reservations` の列（start_at/end_at/depart_at/free_at/status/total_amount）と `attendances`(clock_in_at/clock_out_at・work_date)・`shifts`(start_at/end_at/work_date/is_day_off) を再確認（0008/0020/0007）。列名差異あれば合わせる。

- [ ] **Step 4: seed-demo を流してから通す**

Run: `pnpm db:seed:demo && pnpm test tests/integration/annai-board-p1a.test.ts`
Expected: PASS（2件）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/annai/queries.ts tests/integration/annai-board-p1a.test.ts
git commit -m "feat(annai): listAnnaiBoardCore aggregate query + integration tests"
```

---

### Task 4: 案内表ページ `/admin/annai`（板・読み取り）

**Files:**
- Create: `src/app/(admin)/admin/annai/page.tsx`

- [ ] **Step 1: 実装**

```tsx
// src/app/(admin)/admin/annai/page.tsx
import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { listAnnaiBoardCore } from "@/lib/annai/queries";
import { buildBoard, type BoardRow, type AvailWindow, type JobItem } from "@/domain/annai";

export const dynamic = "force-dynamic";
const TZ = "Asia/Tokyo";
const hm = (d: Date) => formatInTimeZone(d, TZ, "HH:mm");
const hmMs = (ms: number) => formatInTimeZone(new Date(ms), TZ, "HH:mm");

const STATE_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  working: { label: "待機中", bg: "#3F7A6B", fg: "#fff" },
  done: { label: "上がり", bg: "#E7E9E7", fg: "#5b625f" },
};

function centerText(w: AvailWindow): { big: string; sub: string } {
  if (w.kind === "now") return { big: "今すぐ", sub: w.untilMs ? `〜${hmMs(w.untilMs)}` : "上限なし" };
  if (w.kind === "from" && w.fromMs !== null)
    return { big: hmMs(w.fromMs), sub: w.untilMs ? `〜${hmMs(w.untilMs)}` : "上限なし" };
  return { big: "—", sub: "" };
}

function JobCard({ job, side }: { job: JobItem; side: "done" | "up" }) {
  const bg = side === "done" ? "#F3F7F5" : "#FBF3E6";
  const bd = side === "done" ? "#DFE3DE" : "#E9D9BC";
  return (
    <Link
      href={`/admin/reservations/${job.id}`}
      style={{ flex: "0 0 auto", background: bg, border: `1px solid ${bd}`, borderRadius: 6, padding: "5px 9px", textDecoration: "none", color: "#1C2321" }}
    >
      <div style={{ fontSize: 12, fontWeight: 700 }}>
        {hm(job.startAt)}{side === "done" ? `–${hm(job.endAt)}` : ""} ↗
      </div>
      <div style={{ fontSize: 10, color: side === "done" ? "#5b625f" : "#8a5d16" }}>
        {side === "done" ? `¥${job.totalAmount.toLocaleString()}` : `出発${hm(job.departAt)}`}
      </div>
    </Link>
  );
}

function Row({ r }: { r: BoardRow }) {
  const chip = STATE_CHIP[r.attendanceState] ?? STATE_CHIP.working;
  const c = centerText(r.window);
  return (
    <div style={{ background: "#fff", border: "1px solid #DFE3DE", borderRadius: 8, padding: "10px 12px", marginBottom: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 156px 1fr", gap: 8, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", overflowX: "auto" }}>
          {r.done.map((j) => <JobCard key={j.id} job={j} side="done" />)}
        </div>
        <div style={{ background: "#EAF3EF", border: "2px solid #3F7A6B", borderRadius: 8, padding: 5, textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#3F7A6B", fontFamily: "'IBM Plex Mono',monospace", lineHeight: 1.05 }}>{c.big}</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#C98A2B", fontFamily: "'IBM Plex Mono',monospace" }}>{c.sub}</div>
          {r.window.gapMin !== null && r.window.gapMin > 0 && (
            <div style={{ fontSize: 10, color: "#5b625f" }}>空き{r.window.gapMin}分</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-start", overflowX: "auto" }}>
          {r.upcoming.map((j) => <JobCard key={j.id} job={j} side="up" />)}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#9BA5AF", marginTop: 4 }}>
        <Link href={`/admin/therapists/${r.slug}`} style={{ color: "#3F7A6B", fontWeight: 700, fontSize: 13 }}>{r.name}</Link>{" "}
        <span style={{ background: chip.bg, color: chip.fg, padding: "1px 7px", borderRadius: 4, fontSize: 11 }}>{chip.label}</span>
        {r.lateManual && <span style={{ background: "#C98A2B", color: "#fff", padding: "1px 7px", borderRadius: 4, fontSize: 11, marginLeft: 4 }}>遅刻</span>}
      </div>
    </div>
  );
}

export default async function AnnaiPage() {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return <main style={{ padding: 24 }}>権限がありません。</main>;
  }
  const nowMs = Date.now();
  const sql = getClient();
  const rows = await withUser(sql, session, (tx) => listAnnaiBoardCore(tx, nowMs));
  const { active, retired } = buildBoard(rows, nowMs);

  return (
    <main style={{ padding: 24, background: "#F6F7F5", minHeight: "100vh" }}>
      <h1 style={{ color: "#1C2321", marginBottom: 4 }}>案内表</h1>
      <p style={{ color: "#5b625f", fontSize: 13, marginBottom: 12 }}>
        次案内可能が早い順（{formatInTimeZone(new Date(nowMs), TZ, "yyyy-MM-dd HH:mm")}）。名前=予定/売上、予約カード=詳細へ。
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 156px 1fr", gap: 8, marginBottom: 6, fontSize: 10, color: "#9BA5AF" }}>
        <div style={{ textAlign: "right", paddingRight: 4 }}>← 終わった仕事</div>
        <div style={{ textAlign: "center", color: "#2c6152", fontWeight: 700 }}>次案内可能（早い順↓）</div>
        <div style={{ paddingLeft: 4 }}>これからの仕事 →</div>
      </div>
      {active.map((r) => <Row key={r.therapistId} r={r} />)}
      {retired.length > 0 && (
        <>
          <div style={{ height: 5, background: "#404844", borderRadius: 3, margin: "10px 0 6px" }} />
          <div style={{ fontSize: 11, color: "#9BA5AF", fontWeight: 700, marginBottom: 6 }}>上がり</div>
          {retired.map((r) => <Row key={r.therapistId} r={r} />)}
        </>
      )}
      {active.length === 0 && retired.length === 0 && (
        <p style={{ color: "#9BA5AF" }}>本日の出勤・予約がありません。</p>
      )}
    </main>
  );
}
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm build`
Expected: `/admin/annai` が生成されエラーなし。

- [ ] **Step 3: Commit**

```bash
git add "src/app/(admin)/admin/annai/page.tsx"
git commit -m "feat(annai): board read view /admin/annai (v13 layout)"
```

---

### Task 5: 全体検証＋レビュー＋PR

- [ ] **Step 1: 一括検証（CI と同じ UTC でも）**

Run: `pnpm typecheck && pnpm lint && TZ=UTC pnpm test && pnpm build`
Expected: すべて PASS。

- [ ] **Step 2: reviewer(fable) レビュー**

CLAUDE.md 体制に従い reviewer にレビュー依頼（RLS・ウィンドウ計算の境界・any/直書き小数・JST）。指摘反映まででフェーズ完了。

- [ ] **Step 3: PR 作成 → CI 緑 → squash マージ**

```bash
git push -u origin feat/annai-board
gh pr create --title "feat(annai): 案内表ボード P1a（読み取りビュー）" --body "案内表タブの板の読み取りビュー。computeAvailableWindow/buildBoard(純関数)＋listAnnaiBoardCore(RLS集約)＋/admin/annai(v13レイアウト)。予約作成/清算は後続。設計 docs/superpowers/specs/2026-09-02-annai-console-design.md。seed-demo 当日タイムライン同梱。

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review 結果
- **Spec coverage（P1a分）**: 板レイアウト(Task4)・早い順ソート(Task1/2)・次案内可能ウィンドウ＋空き分(Task1)・中央固定/左右横並び(Task4)・状態チップ(Task4)・名前→詳細/予約カード→詳細(Task4)・当日データ集約(Task3)・seed検証(Task3)。予約作成/清算/チェックポイント/時系列/会計は P1b/P2/別（スコープ外）と明記。
- **Placeholder scan**: 実コードを全ステップに記載。Task3 の「実装前に列確認」は列名差異吸収の健全ガード。
- **Type consistency**: `BoardInput/JobItem/AvailWindow/BoardRow/computeAvailableWindow/buildBoard/listAnnaiBoardCore` は契約セクションと各タスクで一致。
