# QR出退勤（attendances）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 事務所のQRを本人がスキャンして出勤/退勤を打刻し、予定(shifts)と実績(attendances)の差分を管理側で可視化する。

**Architecture:** 新テーブル `attendances`（spec 3-5）＋DB非保存の短命署名トークン。純関数（token/state/diff）＋RLS付きクエリ層＋Server Actions（kiosk発行=owner/admin、punch=therapist）＋3画面（kiosk/punch/admin差分）。位置情報は扱わない。制裁機能は作らない（可視化のみ）。

**Tech Stack:** Next.js 15 App Router / postgres.js + RLS(withUser) / Zod / date-fns-tz / node:crypto(HMAC) / qrcode(SVG) / Vitest（統合は実Postgres）。

設計根拠: `docs/superpowers/specs/2026-09-01-qr-attendance-design.md`。

## 型・シグネチャ契約（全タスク共通）

- `src/domain/attendance/token.ts`
  - `TOKEN_TTL_MS = 60_000`
  - `type TokenCheck = { ok: true } | { ok: false; reason: "expired" | "bad_signature" | "malformed" }`
  - `signToken(secret: string, nowMs: number, ttlMs?: number): string`
  - `verifyToken(secret: string, token: string, nowMs: number): TokenCheck`
- `src/domain/attendance/state.ts`
  - `type AttendanceRow = { clockInAt: Date | null; clockOutAt: Date | null }`
  - `type AttendanceState = "off" | "working" | "done"`
  - `nextPunchAction(a: AttendanceRow | null): "clock_in" | "clock_out" | "none"`
  - `deriveAttendanceState(a: AttendanceRow | null): AttendanceState`
- `src/domain/attendance/diff.ts`
  - `type DiffLabel = "予定通り" | "未打刻" | "遅刻" | "早退" | "予定外出勤" | "退勤済"`
  - `compareShiftVsAttendance(plan: {startAt: Date; endAt: Date} | null, actual: {clockInAt: Date | null; clockOutAt: Date | null} | null, nowMs: number): { label: DiffLabel; lateMin?: number; earlyMin?: number }`
- `src/lib/attendance/queries.ts`
  - `punchAttendanceCore(tx, therapistId, action, nowMs): Promise<AttendanceRecord>`
  - `getTodayAttendanceCore(tx, therapistId, nowMs): Promise<AttendanceRecord | null>`
  - `listTodayDiffCore(tx, nowMs): Promise<DiffRow[]>`
- `src/lib/attendance/actions.ts`（"use server"）
  - `issueKioskToken(): Promise<{ ok: true; token: string; svg: string } | { ok: false; reason: string }>`
  - `punchAttendanceAction(input: { token: string; asSlug?: string }): Promise<PunchResult>`

JST 稼働日は `formatInTimeZone(new Date(nowMs), "Asia/Tokyo", "yyyy-MM-dd")`（date-fns-tz、既存 availability と同流儀）。

---

## File Structure

- Create `migrations/0020_attendances.sql` — enum・テーブル・index・updated_atトリガ・RLS・grant
- Create `src/domain/attendance/token.ts` / `token.test.ts` — 署名トークン（純関数）
- Create `src/domain/attendance/state.ts` / `state.test.ts` — 打刻状態機械（純関数）
- Create `src/domain/attendance/diff.ts` / `diff.test.ts` — 予定vs実績の差分ラベル（純関数）
- Create `src/domain/attendance/index.ts` — re-export
- Modify `src/lib/env.ts` — `attendanceQrSecret` 追加
- Create `src/lib/attendance/queries.ts` — RLS 下のクエリ層（tx を受ける Core 群）
- Create `tests/integration/attendance-phaseD.test.ts` — 冪等性・RLS・JST 稼働日
- Create `src/lib/attendance/actions.ts` — Server Actions（kiosk 発行 / punch）
- Create `src/app/(admin)/admin/attendance/kiosk/page.tsx` + `KioskClient.tsx` — 自動更新QR
- Create `src/app/(therapist)/mypage/punch/page.tsx` + `PunchButton.tsx` — 打刻
- Create `src/app/(admin)/admin/attendance/page.tsx` — 当日 予定vs実績 差分表
- Modify `package.json` — `qrcode` 依存追加

---

### Task 1: 依存追加（qrcode）

**Files:**
- Modify: `package.json`

- [ ] **Step 1: qrcode を追加**

Run: `pnpm add qrcode && pnpm add -D @types/qrcode`
Expected: `package.json` の dependencies に `"qrcode"`、devDependencies に `"@types/qrcode"`。

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(attendance): add qrcode dependency for kiosk QR"
```

---

### Task 2: マイグレーション 0020_attendances

**Files:**
- Create: `migrations/0020_attendances.sql`

- [ ] **Step 1: マイグレーションを書く**

```sql
-- 0020_attendances: 出退勤の実績（打刻）（フェーズD / spec 3-5）
--
-- 予定(shifts)と実績(attendances)は分ける。attendances は「実際に打刻された事実」
-- だけを持つ。遅刻・早退・予定外は保存せず、shifts との差分計算で導出する。
-- 位置情報は扱わない（本設計では clock_*_location 列を作らない / spec 3-5 の注意）。
--
-- RLS 必須セット（docs/auth-rls.md §4）: enable + force + ポリシー + app_runtime grant

do $$
begin
  if not exists (select 1 from pg_type where typname = 'attendance_status') then
    create type attendance_status as enum ('working', 'done');
  end if;
end $$;

create table if not exists attendances (
  id            uuid primary key default gen_random_uuid(),
  therapist_id  uuid not null references therapists (id) on delete cascade,
  work_date     date not null,
  clock_in_at   timestamptz,
  clock_out_at  timestamptz,
  status        attendance_status not null default 'working',
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (therapist_id, work_date)
);

create index if not exists attendances_work_date_idx on attendances (work_date);

drop trigger if exists attendances_set_updated_at on attendances;
create trigger attendances_set_updated_at
  before update on attendances
  for each row execute function set_updated_at();

-- RLS -----------------------------------------------------------------------
alter table attendances enable row level security;
alter table attendances force row level security;

drop policy if exists attendances_owner_admin on attendances;
create policy attendances_owner_admin on attendances
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- reception: 当日「誰が動けるか」を見るため select 可
drop policy if exists attendances_reception_select on attendances;
create policy attendances_reception_select on attendances
  for select using (app_current_role() = 'reception');

-- therapist: 自分の行のみ select
drop policy if exists attendances_self_select on attendances;
create policy attendances_self_select on attendances
  for select using (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  );

-- therapist: 自分の行のみ insert（サーバアクションのトークン検証を通った打刻）
drop policy if exists attendances_self_insert on attendances;
create policy attendances_self_insert on attendances
  for insert with check (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  );

-- therapist: 自分の行のみ update（退勤打刻）
drop policy if exists attendances_self_update on attendances;
create policy attendances_self_update on attendances
  for update
  using (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  )
  with check (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  );

grant select, insert, update, delete on attendances to app_runtime;
```

- [ ] **Step 2: マイグレーション適用**

Run: `pnpm db:migrate`
Expected: 0020 が適用され `attendances` テーブルが作成される（エラーなし）。

- [ ] **Step 3: Commit**

```bash
git add migrations/0020_attendances.sql
git commit -m "feat(attendance): 0020 attendances table + RLS (spec 3-5)"
```

---

### Task 3: トークン純関数（token.ts）

**Files:**
- Create: `src/domain/attendance/token.ts`
- Test: `src/domain/attendance/token.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/domain/attendance/token.test.ts
import { describe, expect, it } from "vitest";
import { signToken, verifyToken, TOKEN_TTL_MS } from "./token";

const SECRET = "test-secret-please-change";
const T0 = 1_800_000_000_000;

describe("attendance token", () => {
  it("直後は検証を通る", () => {
    const tok = signToken(SECRET, T0);
    expect(verifyToken(SECRET, tok, T0)).toEqual({ ok: true });
  });

  it("TTL 内は通る（境界の 1ms 手前）", () => {
    const tok = signToken(SECRET, T0);
    expect(verifyToken(SECRET, tok, T0 + TOKEN_TTL_MS - 1)).toEqual({ ok: true });
  });

  it("TTL 超過は expired", () => {
    const tok = signToken(SECRET, T0);
    expect(verifyToken(SECRET, tok, T0 + TOKEN_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("別の鍵では bad_signature", () => {
    const tok = signToken(SECRET, T0);
    expect(verifyToken("other-secret", tok, T0)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("改ざん payload は bad_signature", () => {
    const tok = signToken(SECRET, T0);
    const [p, s] = tok.split(".");
    const tampered = `${p}x.${s}`;
    const r = verifyToken(SECRET, tampered, T0);
    expect(r.ok).toBe(false);
  });

  it("壊れた形式は malformed", () => {
    expect(verifyToken(SECRET, "not-a-token", T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm test src/domain/attendance/token.test.ts`
Expected: FAIL（`./token` が存在しない）。

- [ ] **Step 3: 実装を書く**

```ts
// src/domain/attendance/token.ts
import { createHmac, timingSafeEqual } from "node:crypto";

/** トークンの有効期間（ms）。キオスクは 45秒ごとに更新（重複窓で切れ目なし）。 */
export const TOKEN_TTL_MS = 60_000;

export type TokenCheck =
  | { ok: true }
  | { ok: false; reason: "expired" | "bad_signature" | "malformed" };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(secret: string, payload: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

/** payload = base64url(JSON{iat,exp})、token = payload + "." + signature */
export function signToken(secret: string, nowMs: number, ttlMs: number = TOKEN_TTL_MS): string {
  const payload = b64url(Buffer.from(JSON.stringify({ iat: nowMs, exp: nowMs + ttlMs })));
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyToken(secret: string, token: string, nowMs: number): TokenCheck {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts;

  const expected = sign(secret, payload);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let decoded: { iat: number; exp: number };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof decoded.exp !== "number") return { ok: false, reason: "malformed" };
  if (nowMs >= decoded.exp) return { ok: false, reason: "expired" };
  return { ok: true };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test src/domain/attendance/token.test.ts`
Expected: PASS（6件）。

- [ ] **Step 5: Commit**

```bash
git add src/domain/attendance/token.ts src/domain/attendance/token.test.ts
git commit -m "feat(attendance): short-lived signed QR token (pure)"
```

---

### Task 4: 打刻状態機械（state.ts）

**Files:**
- Create: `src/domain/attendance/state.ts`
- Test: `src/domain/attendance/state.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/domain/attendance/state.test.ts
import { describe, expect, it } from "vitest";
import { nextPunchAction, deriveAttendanceState } from "./state";

const D = (h: number) => new Date(2026, 8, 1, h, 0, 0);

describe("nextPunchAction", () => {
  it("行なし → clock_in", () => {
    expect(nextPunchAction(null)).toBe("clock_in");
  });
  it("出勤済・未退勤 → clock_out", () => {
    expect(nextPunchAction({ clockInAt: D(18), clockOutAt: null })).toBe("clock_out");
  });
  it("退勤済 → none", () => {
    expect(nextPunchAction({ clockInAt: D(18), clockOutAt: D(26 - 24) })).toBe("none");
  });
});

describe("deriveAttendanceState", () => {
  it("null → off", () => expect(deriveAttendanceState(null)).toBe("off"));
  it("出勤のみ → working", () =>
    expect(deriveAttendanceState({ clockInAt: D(18), clockOutAt: null })).toBe("working"));
  it("退勤済 → done", () =>
    expect(deriveAttendanceState({ clockInAt: D(18), clockOutAt: D(2) })).toBe("done"));
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm test src/domain/attendance/state.test.ts`
Expected: FAIL（`./state` 未実装）。

- [ ] **Step 3: 実装を書く**

```ts
// src/domain/attendance/state.ts
export type AttendanceRow = { clockInAt: Date | null; clockOutAt: Date | null };
export type AttendanceState = "off" | "working" | "done";

/** 次に押すべき打刻。行なし→出勤／出勤済未退勤→退勤／退勤済→なし。 */
export function nextPunchAction(a: AttendanceRow | null): "clock_in" | "clock_out" | "none" {
  if (!a || !a.clockInAt) return "clock_in";
  if (!a.clockOutAt) return "clock_out";
  return "none";
}

/** 案内表が消費する土台。off=未出勤 / working=出勤中 / done=退勤済。 */
export function deriveAttendanceState(a: AttendanceRow | null): AttendanceState {
  if (!a || !a.clockInAt) return "off";
  return a.clockOutAt ? "done" : "working";
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test src/domain/attendance/state.test.ts`
Expected: PASS（6件）。

- [ ] **Step 5: Commit**

```bash
git add src/domain/attendance/state.ts src/domain/attendance/state.test.ts
git commit -m "feat(attendance): punch state machine (pure)"
```

---

### Task 5: 差分ラベル（diff.ts）

**Files:**
- Create: `src/domain/attendance/diff.ts`
- Test: `src/domain/attendance/diff.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/domain/attendance/diff.test.ts
import { describe, expect, it } from "vitest";
import { compareShiftVsAttendance } from "./diff";

const at = (h: number, m = 0) => new Date(2026, 8, 1, h, m, 0);
const NOW = at(20).getTime();

describe("compareShiftVsAttendance", () => {
  it("予定あり・打刻なし・予定開始を過ぎている → 未打刻", () => {
    expect(compareShiftVsAttendance({ startAt: at(18), endAt: at(26 - 24) }, null, NOW).label).toBe(
      "未打刻",
    );
  });

  it("予定なし・出勤打刻あり → 予定外出勤", () => {
    expect(
      compareShiftVsAttendance(null, { clockInAt: at(19), clockOutAt: null }, NOW).label,
    ).toBe("予定外出勤");
  });

  it("予定開始より遅い出勤 → 遅刻（分も返す）", () => {
    const r = compareShiftVsAttendance(
      { startAt: at(18), endAt: at(23) },
      { clockInAt: at(18, 20), clockOutAt: null },
      NOW,
    );
    expect(r.label).toBe("遅刻");
    expect(r.lateMin).toBe(20);
  });

  it("予定終了より早い退勤 → 早退（分も返す）", () => {
    const r = compareShiftVsAttendance(
      { startAt: at(18), endAt: at(23) },
      { clockInAt: at(18), clockOutAt: at(22, 30) },
      NOW,
    );
    expect(r.label).toBe("早退");
    expect(r.earlyMin).toBe(30);
  });

  it("退勤済で早退でない → 退勤済", () => {
    expect(
      compareShiftVsAttendance(
        { startAt: at(18), endAt: at(22) },
        { clockInAt: at(18), clockOutAt: at(22) },
        NOW,
      ).label,
    ).toBe("退勤済");
  });

  it("予定通り出勤・稼働中 → 予定通り", () => {
    expect(
      compareShiftVsAttendance(
        { startAt: at(18), endAt: at(23) },
        { clockInAt: at(18), clockOutAt: null },
        NOW,
      ).label,
    ).toBe("予定通り");
  });

  it("予定あり・打刻なし・まだ予定開始前 → 予定通り", () => {
    const before = at(17).getTime();
    expect(
      compareShiftVsAttendance({ startAt: at(18), endAt: at(23) }, null, before).label,
    ).toBe("予定通り");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm test src/domain/attendance/diff.test.ts`
Expected: FAIL（`./diff` 未実装）。

- [ ] **Step 3: 実装を書く**

```ts
// src/domain/attendance/diff.ts
//
// 予定(shift)と実績(attendance)の差分ラベルを導出する純関数。
// 用途は「稼働の可視化」（spec 3-5）。遅刻/早退は事実の表示であって
// 制裁・時間管理のためではない（spec 16章）。
export type DiffLabel =
  | "予定通り"
  | "未打刻"
  | "遅刻"
  | "早退"
  | "予定外出勤"
  | "退勤済";

type Plan = { startAt: Date; endAt: Date } | null;
type Actual = { clockInAt: Date | null; clockOutAt: Date | null } | null;

const MIN = 60_000;

export function compareShiftVsAttendance(
  plan: Plan,
  actual: Actual,
  nowMs: number,
): { label: DiffLabel; lateMin?: number; earlyMin?: number } {
  const inAt = actual?.clockInAt ?? null;
  const outAt = actual?.clockOutAt ?? null;

  // 予定なし
  if (!plan) {
    if (inAt) return { label: "予定外出勤" };
    return { label: "予定通り" }; // 予定も実績も無い＝対象外扱い
  }

  // 予定あり・未出勤
  if (!inAt) {
    // 予定開始を過ぎても打刻が無い → 未打刻。まだ開始前なら予定通り。
    return nowMs > plan.startAt.getTime() ? { label: "未打刻" } : { label: "予定通り" };
  }

  // 退勤済
  if (outAt) {
    const earlyMs = plan.endAt.getTime() - outAt.getTime();
    if (earlyMs > 0) return { label: "早退", earlyMin: Math.round(earlyMs / MIN) };
    return { label: "退勤済" };
  }

  // 稼働中：遅刻判定
  const lateMs = inAt.getTime() - plan.startAt.getTime();
  if (lateMs > 0) return { label: "遅刻", lateMin: Math.round(lateMs / MIN) };
  return { label: "予定通り" };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test src/domain/attendance/diff.test.ts`
Expected: PASS（7件）。

- [ ] **Step 5: index.ts で re-export**

```ts
// src/domain/attendance/index.ts
export { signToken, verifyToken, TOKEN_TTL_MS } from "./token";
export type { TokenCheck } from "./token";
export { nextPunchAction, deriveAttendanceState } from "./state";
export type { AttendanceRow, AttendanceState } from "./state";
export { compareShiftVsAttendance } from "./diff";
export type { DiffLabel } from "./diff";
```

- [ ] **Step 6: Commit**

```bash
git add src/domain/attendance/diff.ts src/domain/attendance/diff.test.ts src/domain/attendance/index.ts
git commit -m "feat(attendance): shift-vs-actual diff labels (pure) + index"
```

---

### Task 6: env に秘密鍵を追加

**Files:**
- Modify: `src/lib/env.ts`

- [ ] **Step 1: env に追記**

`src/lib/env.ts` の `emailFrom: read("EMAIL_FROM"),` の直後に追加：

```ts
  /** QR出退勤キオスクの署名秘密鍵（フェーズD）。未設定でもビルドは通る
   *  （キオスク画面が「未設定」を表示し発行しない / feedback-no-over-configuration） */
  attendanceQrSecret: read("ATTENDANCE_QR_SECRET"),
```

- [ ] **Step 2: 型チェック**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/lib/env.ts
git commit -m "feat(attendance): ATTENDANCE_QR_SECRET env (lenient)"
```

---

### Task 7: クエリ層（queries.ts）＋統合テスト

**Files:**
- Create: `src/lib/attendance/queries.ts`
- Test: `tests/integration/attendance-phaseD.test.ts`

- [ ] **Step 1: 失敗する統合テストを書く**

```ts
// tests/integration/attendance-phaseD.test.ts
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { getTodayAttendanceCore, punchAttendanceCore } from "@/lib/attendance/queries";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });

// seed の app_users（scripts/seed.ts）
const OWNER: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "owner" };
const AOI: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000004", role: "therapist" };
const REN: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000005", role: "therapist" };

// 他テストと衝突しない未来日で検証（work_date は JST 稼働日）
const NOW = new Date(2027, 0, 15, 18, 0, 0).getTime(); // 2027-01-15 18:00 JST 相当

afterAll(async () => {
  await sql`delete from attendances where work_date = '2027-01-15'`;
  await sql.end();
});

describe("attendance queries (実Postgres)", () => {
  it("出勤→退勤→再打刻: 冪等で二重打刻しない", async () => {
    const t = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    const therapistId = t[0]!.id;

    const a = await withUser(sql, AOI, (tx) =>
      punchAttendanceCore(tx, therapistId, "clock_in", NOW),
    );
    expect(a.clockInAt).not.toBeNull();
    expect(a.status).toBe("working");

    // 同じ clock_in をもう一度 → 冪等（clockInAt は変わらない）
    const a2 = await withUser(sql, AOI, (tx) =>
      punchAttendanceCore(tx, therapistId, "clock_in", NOW + 60_000),
    );
    expect(a2.clockInAt!.getTime()).toBe(a.clockInAt!.getTime());

    // 退勤
    const b = await withUser(sql, AOI, (tx) =>
      punchAttendanceCore(tx, therapistId, "clock_out", NOW + 3_600_000),
    );
    expect(b.clockOutAt).not.toBeNull();
    expect(b.status).toBe("done");

    // 退勤の二度押しも冪等（clockOutAt 不変）
    const b2 = await withUser(sql, AOI, (tx) =>
      punchAttendanceCore(tx, therapistId, "clock_out", NOW + 7_200_000),
    );
    expect(b2.clockOutAt!.getTime()).toBe(b.clockOutAt!.getTime());
  });

  it("work_date は JST 稼働日で確定する", async () => {
    const t = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    const rec = await withUser(sql, AOI, (tx) =>
      getTodayAttendanceCore(tx, t[0]!.id, NOW),
    );
    expect(rec?.workDate).toBe("2027-01-15");
  });

  it("RLS: 他人の当日実績は select できない", async () => {
    const aoi = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    // れんのセッションで あおい の行を読もうとしても null
    const rec = await withUser(sql, REN, (tx) =>
      getTodayAttendanceCore(tx, aoi[0]!.id, NOW),
    );
    expect(rec).toBeNull();
  });

  it("RLS: owner は誰の実績も読める", async () => {
    const aoi = await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`;
    const rec = await withUser(sql, OWNER, (tx) =>
      getTodayAttendanceCore(tx, aoi[0]!.id, NOW),
    );
    expect(rec?.workDate).toBe("2027-01-15");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm test tests/integration/attendance-phaseD.test.ts`
Expected: FAIL（`@/lib/attendance/queries` 未実装）。

- [ ] **Step 3: 実装を書く**

```ts
// src/lib/attendance/queries.ts
import "server-only";
import type { TransactionSql } from "postgres";
import { formatInTimeZone } from "date-fns-tz";

export interface AttendanceRecord {
  id: string;
  therapistId: string;
  workDate: string; // YYYY-MM-DD（JST）
  clockInAt: Date | null;
  clockOutAt: Date | null;
  status: "working" | "done";
}

const TZ = "Asia/Tokyo";

function jstDate(nowMs: number): string {
  return formatInTimeZone(new Date(nowMs), TZ, "yyyy-MM-dd");
}

function mapRow(r: {
  id: string;
  therapist_id: string;
  work_date: string;
  clock_in_at: Date | null;
  clock_out_at: Date | null;
  status: "working" | "done";
}): AttendanceRecord {
  return {
    id: r.id,
    therapistId: r.therapist_id,
    workDate: typeof r.work_date === "string" ? r.work_date : jstDateFromValue(r.work_date),
    clockInAt: r.clock_in_at,
    clockOutAt: r.clock_out_at,
    status: r.status,
  };
}

// postgres.js は date 列を文字列で返す（型 'date'）。保険として Date が来ても JST 日付へ。
function jstDateFromValue(v: unknown): string {
  return formatInTimeZone(new Date(v as string), TZ, "yyyy-MM-dd");
}

/** 当日（JST）の自分の実績を1件返す（無ければ null）。RLS 下で呼ぶこと。 */
export async function getTodayAttendanceCore(
  tx: TransactionSql,
  therapistId: string,
  nowMs: number,
): Promise<AttendanceRecord | null> {
  const wd = jstDate(nowMs);
  const rows = await tx<Parameters<typeof mapRow>[0][]>`
    select id, therapist_id, work_date::text as work_date, clock_in_at, clock_out_at, status
    from attendances
    where therapist_id = ${therapistId} and work_date = ${wd}
    limit 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * 打刻。clock_in は行を upsert して clock_in_at を「未設定のときだけ」入れる（冪等）。
 * clock_out は clock_out_at を「未設定のときだけ」入れて status='done'（冪等）。
 * RLS 下で呼ぶこと（本人 therapist_id のみ通る）。
 */
export async function punchAttendanceCore(
  tx: TransactionSql,
  therapistId: string,
  action: "clock_in" | "clock_out",
  nowMs: number,
): Promise<AttendanceRecord> {
  const wd = jstDate(nowMs);
  const now = new Date(nowMs);

  if (action === "clock_in") {
    await tx`
      insert into attendances (therapist_id, work_date, clock_in_at, status)
      values (${therapistId}, ${wd}, ${now}, 'working')
      on conflict (therapist_id, work_date) do update
        set clock_in_at = coalesce(attendances.clock_in_at, excluded.clock_in_at)
    `;
  } else {
    await tx`
      insert into attendances (therapist_id, work_date, clock_in_at, clock_out_at, status)
      values (${therapistId}, ${wd}, ${now}, ${now}, 'done')
      on conflict (therapist_id, work_date) do update
        set clock_out_at = coalesce(attendances.clock_out_at, excluded.clock_out_at),
            clock_in_at  = coalesce(attendances.clock_in_at, excluded.clock_in_at),
            status = 'done'
    `;
  }

  const rec = await getTodayAttendanceCore(tx, therapistId, nowMs);
  if (!rec) throw new Error("attendance upsert failed");
  return rec;
}

export interface DiffRow {
  therapistId: string;
  slug: string;
  name: string;
  planStartAt: Date | null;
  planEndAt: Date | null;
  clockInAt: Date | null;
  clockOutAt: Date | null;
}

/** 当日（JST）の全セラピストの 予定(shift) と 実績(attendance) を突き合わせて返す。 */
export async function listTodayDiffCore(tx: TransactionSql, nowMs: number): Promise<DiffRow[]> {
  const wd = jstDate(nowMs);
  const rows = await tx<
    {
      therapist_id: string;
      slug: string;
      name: string | null;
      plan_start_at: Date | null;
      plan_end_at: Date | null;
      clock_in_at: Date | null;
      clock_out_at: Date | null;
    }[]
  >`
    select
      t.id as therapist_id,
      t.slug as slug,
      (er.draft ->> 'name') as name,
      s.start_at as plan_start_at,
      s.end_at as plan_end_at,
      a.clock_in_at as clock_in_at,
      a.clock_out_at as clock_out_at
    from therapists t
    left join entity_records er
      on er.entity = 'therapist' and er.slug = t.slug
    left join shifts s
      on s.therapist_id = t.id and s.work_date = ${wd} and s.is_day_off = false
    left join attendances a
      on a.therapist_id = t.id and a.work_date = ${wd}
    where t.status = 'active'
    order by a.clock_in_at nulls last, s.start_at nulls last, t.display_order
  `;
  return rows.map((r) => ({
    therapistId: r.therapist_id,
    slug: r.slug,
    name: r.name ?? r.slug,
    planStartAt: r.plan_start_at,
    planEndAt: r.plan_end_at,
    clockInAt: r.clock_in_at,
    clockOutAt: r.clock_out_at,
  }));
}
```

> 注意: `shifts` の日付列名・開始終了列名は既存 `migrations/0007_shifts.sql` に合わせること。列名が `work_date`/`start_at`/`end_at` でない場合は 0007 の定義に合わせて上記 SQL を修正する（実装前に `sed -n '33,66p' migrations/0007_shifts.sql` で確認）。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test tests/integration/attendance-phaseD.test.ts`
Expected: PASS（4件）。落ちる場合は shifts の列名差異を Step 3 の注意に従って修正。

- [ ] **Step 5: Commit**

```bash
git add src/lib/attendance/queries.ts tests/integration/attendance-phaseD.test.ts
git commit -m "feat(attendance): RLS query layer (punch idempotent, today diff) + integration tests"
```

---

### Task 8: Server Actions（actions.ts）

**Files:**
- Create: `src/lib/attendance/actions.ts`

- [ ] **Step 1: 実装を書く**

```ts
// src/lib/attendance/actions.ts
"use server";

/**
 * QR出退勤の Server Actions（フェーズD / spec 3-5）。
 * - issueKioskToken: owner/admin のみ。短命署名トークン＋QR(SVG) を返す。
 * - punchAttendanceAction: therapist のみ。トークン再検証 → 本人の打刻（冪等）。
 * 位置情報は扱わない。制裁機能は作らない（可視化のみ）。
 */

import { z } from "zod";
import { toDataURL, toString as qrToString } from "qrcode";
import { can } from "@/domain/auth";
import { signToken, verifyToken } from "@/domain/attendance";
import { nextPunchAction } from "@/domain/attendance";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { toActor } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { getDevSession } from "@/lib/cms/dev-session";
import { getTherapistDevSession } from "@/lib/cms/dev-session";
import {
  getTodayAttendanceCore,
  punchAttendanceCore,
} from "@/lib/attendance/queries";

export interface KioskTokenResult {
  ok: boolean;
  token?: string;
  svg?: string;
  reason?: string;
}

/** キオスク用トークン＋QR(SVG)。QR の中身は /mypage/punch?t=<token>。 */
export async function issueKioskToken(): Promise<KioskTokenResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, reason: "unauthenticated" };
  const actor = toActor(session);
  if (!can(actor, "manage_cms")) return { ok: false, reason: "forbidden" };

  const secret = env.attendanceQrSecret;
  if (!secret) return { ok: false, reason: "no_secret" };

  const token = signToken(secret, Date.now());
  const base = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "";
  const url = `${base}/mypage/punch?t=${encodeURIComponent(token)}`;
  const svg = await qrToString(url, { type: "svg", margin: 1, width: 320 });
  return { ok: true, token, svg };
}

const punchInput = z.object({
  token: z.string().min(1),
  asSlug: z.string().optional(), // dev なりすまし（本番は無視される）
});

export interface PunchResult {
  ok: boolean;
  action?: "clock_in" | "clock_out" | "none";
  at?: string; // ISO
  reason?: "invalid_token" | "expired" | "no_secret" | "unauthenticated" | "already_done";
}

export async function punchAttendanceAction(input: z.infer<typeof punchInput>): Promise<PunchResult> {
  const { token, asSlug } = punchInput.parse(input);

  const secret = env.attendanceQrSecret;
  if (!secret) return { ok: false, reason: "no_secret" };

  const check = verifyToken(secret, token, Date.now());
  if (!check.ok) return { ok: false, reason: check.reason === "expired" ? "expired" : "invalid_token" };

  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, reason: "unauthenticated" };

  const sql = getClient();
  return withUser(sql, session, async (tx) => {
    // 本人 therapist_id を app_users から解決
    const who = await tx<{ therapist_id: string | null }[]>`
      select therapist_id from app_users where id = ${session.userId} limit 1
    `;
    const therapistId = who[0]?.therapist_id;
    if (!therapistId) return { ok: false, reason: "unauthenticated" as const };

    const now = Date.now();
    const current = await getTodayAttendanceCore(tx, therapistId, now);
    const action = nextPunchAction(
      current ? { clockInAt: current.clockInAt, clockOutAt: current.clockOutAt } : null,
    );
    if (action === "none") return { ok: false, reason: "already_done" as const };

    const rec = await punchAttendanceCore(tx, therapistId, action, now);
    const at = action === "clock_in" ? rec.clockInAt : rec.clockOutAt;
    return { ok: true, action, at: at ? at.toISOString() : undefined };
  });
}
```

> 実装前に `src/lib/cms/dev-session.ts` の `getDevSession` / `getTherapistDevSession` のシグネチャと、`src/domain/auth` の `can` 能力キー（`manage_cms` 等）を確認して合わせること（`git grep -n "export function getDevSession\|export async function getTherapistDevSession" src/lib/cms/dev-session.ts` と `sed -n '1,60p' src/domain/auth/capabilities.ts`）。

- [ ] **Step 2: 型チェック**

Run: `pnpm typecheck`
Expected: PASS。失敗する場合は上記シグネチャ差異を修正。

- [ ] **Step 3: Commit**

```bash
git add src/lib/attendance/actions.ts
git commit -m "feat(attendance): server actions (kiosk token issue, punch)"
```

---

### Task 9: キオスク画面（自動更新QR）

**Files:**
- Create: `src/app/(admin)/admin/attendance/kiosk/page.tsx`
- Create: `src/app/(admin)/admin/attendance/kiosk/KioskClient.tsx`

- [ ] **Step 1: サーバページ**

```tsx
// src/app/(admin)/admin/attendance/kiosk/page.tsx
import KioskClient from "./KioskClient";

export const dynamic = "force-dynamic";

export default function AttendanceKioskPage() {
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: "#1C2321", marginBottom: 4 }}>出退勤 キオスク</h1>
      <p style={{ color: "#5b625f", fontSize: 13, marginBottom: 16 }}>
        事務所の端末に表示し、セラピスト本人のスマホでスキャンしてもらいます。QRは自動更新されます。
      </p>
      <KioskClient />
    </main>
  );
}
```

- [ ] **Step 2: クライアント島（45秒ごとに再取得）**

```tsx
// src/app/(admin)/admin/attendance/kiosk/KioskClient.tsx
"use client";

import { useEffect, useState } from "react";
import { issueKioskToken } from "@/lib/attendance/actions";

export default function KioskClient() {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await issueKioskToken();
      if (!alive) return;
      if (r.ok && r.svg) {
        setSvg(r.svg);
        setErr(null);
      } else {
        setErr(r.reason ?? "error");
      }
    };
    void tick();
    const id = setInterval(tick, 45_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (err === "no_secret") {
    return (
      <div style={{ color: "#B4453C", fontSize: 14 }}>
        ATTENDANCE_QR_SECRET が未設定です。環境変数を設定するとQRを発行します。
      </div>
    );
  }
  if (err) return <div style={{ color: "#B4453C" }}>発行に失敗しました（{err}）。</div>;
  if (!svg) return <div style={{ color: "#5b625f" }}>QRを生成中…</div>;

  return (
    <div
      aria-label="出退勤QRコード"
      style={{ width: 320, height: 320 }}
      // qrToString の出力（自社サーバ生成の信頼できるSVG）
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
```

- [ ] **Step 3: ビルドで確認**

Run: `pnpm build`
Expected: 該当ルートが生成されエラーなし。

- [ ] **Step 4: Commit**

```bash
git add "src/app/(admin)/admin/attendance/kiosk/"
git commit -m "feat(attendance): kiosk auto-refreshing QR screen"
```

---

### Task 10: 打刻画面（/mypage/punch）

**Files:**
- Create: `src/app/(therapist)/mypage/punch/page.tsx`
- Create: `src/app/(therapist)/mypage/punch/PunchButton.tsx`

- [ ] **Step 1: サーバページ（トークン検証＋状態判定）**

```tsx
// src/app/(therapist)/mypage/punch/page.tsx
import { verifyToken } from "@/domain/attendance";
import { nextPunchAction } from "@/domain/attendance";
import { env } from "@/lib/env";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { getTherapistDevSession } from "@/lib/cms/dev-session";
import { getTodayAttendanceCore } from "@/lib/attendance/queries";
import PunchButton from "./PunchButton";

export const dynamic = "force-dynamic";

export default async function PunchPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; as?: string }>;
}) {
  const { t, as } = await searchParams;
  const wrap = (msg: string, tone: "err" | "ok" = "err") => (
    <main style={{ padding: 24, maxWidth: 420, margin: "0 auto" }}>
      <p style={{ color: tone === "err" ? "#B4453C" : "#2c6152", fontSize: 16 }}>{msg}</p>
    </main>
  );

  const secret = env.attendanceQrSecret;
  if (!secret) return wrap("打刻は現在利用できません（設定未完了）。");
  if (!t) return wrap("QRから開いてください。");
  const check = verifyToken(secret, t, Date.now());
  if (!check.ok) {
    return wrap(check.reason === "expired" ? "QRの有効期限が切れました。事務所の画面を撮り直してください。" : "QRが不正です。");
  }

  const session = await getTherapistDevSession(as);
  if (!session) return wrap("ログインが必要です。");

  const sql = getClient();
  const { name, action } = await withUser(sql, session, async (tx) => {
    const who = await tx<{ therapist_id: string | null; display_name: string | null }[]>`
      select therapist_id, display_name from app_users where id = ${session.userId} limit 1
    `;
    const therapistId = who[0]?.therapist_id ?? null;
    if (!therapistId) return { name: null as string | null, action: "none" as const };
    const cur = await getTodayAttendanceCore(tx, therapistId, Date.now());
    return {
      name: who[0]?.display_name ?? null,
      action: nextPunchAction(cur ? { clockInAt: cur.clockInAt, clockOutAt: cur.clockOutAt } : null),
    };
  });

  if (!name) return wrap("セラピストアカウントが見つかりません。");
  if (action === "none") return wrap("本日はすでに退勤済みです。おつかれさまでした。", "ok");

  return (
    <main style={{ padding: 24, maxWidth: 420, margin: "0 auto" }}>
      <p style={{ color: "#1C2321", fontSize: 15, marginBottom: 4 }}>{name} さん</p>
      <p style={{ color: "#5b625f", fontSize: 13, marginBottom: 20 }}>
        {action === "clock_in" ? "出勤を打刻します" : "退勤を打刻します"}
      </p>
      <PunchButton token={t} asSlug={as} action={action} />
    </main>
  );
}
```

- [ ] **Step 2: クライアント（ワンタップ打刻）**

```tsx
// src/app/(therapist)/mypage/punch/PunchButton.tsx
"use client";

import { useState } from "react";
import { punchAttendanceAction } from "@/lib/attendance/actions";

export default function PunchButton({
  token,
  asSlug,
  action,
}: {
  token: string;
  asSlug?: string;
  action: "clock_in" | "clock_out";
}) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  const onClick = async () => {
    setState("sending");
    const r = await punchAttendanceAction({ token, asSlug });
    if (r.ok) {
      setState("done");
      setMsg(r.action === "clock_in" ? "出勤を記録しました" : "退勤を記録しました。おつかれさまでした");
    } else {
      setState("error");
      setMsg(
        r.reason === "expired"
          ? "QRの有効期限が切れました。事務所の画面を撮り直してください"
          : r.reason === "already_done"
            ? "本日はすでに退勤済みです"
            : "記録できませんでした",
      );
    }
  };

  if (state === "done") return <p style={{ color: "#2c6152", fontSize: 16 }}>✓ {msg}</p>;

  return (
    <div>
      <button
        onClick={onClick}
        disabled={state === "sending"}
        style={{
          width: "100%",
          padding: "16px",
          fontSize: 18,
          fontWeight: 700,
          color: "#fff",
          background: action === "clock_in" ? "#3F7A6B" : "#C98A2B",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
        }}
      >
        {state === "sending" ? "記録中…" : action === "clock_in" ? "出勤" : "退勤"}
      </button>
      {state === "error" && <p style={{ color: "#B4453C", marginTop: 12 }}>{msg}</p>}
    </div>
  );
}
```

- [ ] **Step 3: ビルドで確認**

Run: `pnpm build`
Expected: 該当ルート生成・エラーなし。

- [ ] **Step 4: Commit**

```bash
git add "src/app/(therapist)/mypage/punch/"
git commit -m "feat(attendance): therapist punch screen (token-gated, one-tap)"
```

---

### Task 11: 管理 当日 予定vs実績 差分表

**Files:**
- Create: `src/app/(admin)/admin/attendance/page.tsx`

- [ ] **Step 1: サーバページ**

```tsx
// src/app/(admin)/admin/attendance/page.tsx
import { formatInTimeZone } from "date-fns-tz";
import { compareShiftVsAttendance } from "@/domain/attendance";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { listTodayDiffCore } from "@/lib/attendance/queries";

export const dynamic = "force-dynamic";

const TZ = "Asia/Tokyo";
const hm = (d: Date | null) => (d ? formatInTimeZone(d, TZ, "HH:mm") : "—");

const LABEL_COLOR: Record<string, string> = {
  遅刻: "#C98A2B",
  早退: "#C98A2B",
  未打刻: "#B4453C",
  予定外出勤: "#3F7A6B",
  退勤済: "#5b625f",
  予定通り: "#2c6152",
};

export default async function AdminAttendancePage() {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return <main style={{ padding: 24 }}>権限がありません。</main>;
  }

  const now = Date.now();
  const sql = getClient();
  const rows = await withUser(sql, session, (tx) => listTodayDiffCore(tx, now));

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: "#1C2321", marginBottom: 4 }}>出退勤（当日）</h1>
      <p style={{ color: "#5b625f", fontSize: 13, marginBottom: 16 }}>
        予定と実績の差分。稼働の可視化が目的です（{formatInTimeZone(new Date(now), TZ, "yyyy-MM-dd")}）。
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#EEF1EF", textAlign: "left" }}>
            <th style={{ padding: 8 }}>女性</th>
            <th>予定</th>
            <th>出勤</th>
            <th>退勤</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const plan = r.planStartAt && r.planEndAt ? { startAt: r.planStartAt, endAt: r.planEndAt } : null;
            const actual = { clockInAt: r.clockInAt, clockOutAt: r.clockOutAt };
            const d = compareShiftVsAttendance(plan, actual, now);
            const extra =
              d.label === "遅刻" ? `（${d.lateMin}分）` : d.label === "早退" ? `（${d.earlyMin}分）` : "";
            return (
              <tr key={r.therapistId} style={{ borderTop: "1px solid #DFE3DE", background: "#fff" }}>
                <td style={{ padding: 8 }}>{r.name}</td>
                <td>{plan ? `${hm(r.planStartAt)}–${hm(r.planEndAt)}` : "—"}</td>
                <td>{hm(r.clockInAt)}</td>
                <td>{hm(r.clockOutAt)}</td>
                <td style={{ color: LABEL_COLOR[d.label] ?? "#1C2321", fontWeight: 700 }}>
                  {d.label}
                  {extra}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
```

- [ ] **Step 2: ビルドで確認**

Run: `pnpm build`
Expected: 該当ルート生成・エラーなし。

- [ ] **Step 3: Commit**

```bash
git add "src/app/(admin)/admin/attendance/page.tsx"
git commit -m "feat(attendance): admin today plan-vs-actual diff table"
```

---

### Task 12: 全体検証

- [ ] **Step 1: 一括検証**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: すべて PASS。any/直書き小数なし。

- [ ] **Step 2: 直書き日本語 grep（公開側のみ禁止。管理/マイページはOKだが確認）**

Run: `git grep -n "案内表\|出勤" -- 'src/app/(public)/**' || echo "public に混入なし"`
Expected: 公開側に本機能の日本語が漏れていないこと。

- [ ] **Step 3: reviewer レビュー（fable）**

CLAUDE.md 体制に従い reviewer サブエージェントにレビュー依頼（RLSバイパス・冪等性・トークン検証・any/小数/直書き）。指摘修正まででフェーズ完了。

- [ ] **Step 4: PR 作成**

```bash
git push -u origin feat/qr-attendance
gh pr create --title "feat(attendance): QR出退勤（方式A・短命署名トークン・attendances）" --body "$(cat <<'EOF'
## 概要
事務所QRを本人がスキャンして出勤/退勤を打刻（spec 3-5）。予定(shifts)と実績(attendances)を分離。位置情報なし・制裁機能なし（可視化のみ）。

## 含むもの
- 0020_attendances（RLS: 本人/owner/admin/reception）
- 純関数 token/state/diff（+テスト）
- クエリ層（冪等 punch・当日差分）＋実Postgres統合テスト（冪等/RLS/JST稼働日）
- Server Actions（kiosk発行=owner/admin, punch=therapist）
- 画面: /admin/attendance/kiosk・/mypage/punch・/admin/attendance
- 案内表への土台 deriveAttendanceState を提供

## 発注者ステップ（停止条件②）
- 本番: ATTENDANCE_QR_SECRET を Vercel に設定
- 本番打刻はキャストアカウント bootstrap 後（既知の依存）
- Supabase 0020 同期

設計: docs/superpowers/specs/2026-09-01-qr-attendance-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review 結果

- **Spec coverage:** データモデル(Task2)・トークン(Task3)・状態(Task4)・差分(Task5)・env(Task6)・RLSクエリ+統合(Task7)・アクション(Task8)・kiosk(Task9)・punch(Task10)・admin差分(Task11)・案内表土台=state.ts の deriveAttendanceState(Task4/index)。全 spec 節に対応タスクあり。
- **Placeholder scan:** 実コードを全ステップに記載。TBD/TODO なし。2箇所「実装前に既存シグネチャ確認」の注記は列名/関数名の差異吸収のための健全なガード（プレースホルダではない）。
- **Type consistency:** `nextPunchAction`/`deriveAttendanceState`/`verifyToken`/`compareShiftVsAttendance`/`punchAttendanceCore`/`getTodayAttendanceCore`/`listTodayDiffCore`/`issueKioskToken`/`punchAttendanceAction` の名称・引数は契約セクションと各タスクで一致。
