# 配車表 フェーズ6（送り台帳＋退勤送り）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 女性ごとの「送り台帳」（自宅/寮/宿泊先・往復時間・同乗NG等の備考）を登録できるようにし、配車ボードに**退勤送り（自宅・寮送り＝予約でない配車）**を手動追加（送り台帳から自動補完）できるようにする。

**Architecture:** `therapist_transport`(+`_routes`) マスタ（0035）＋登録画面 `/admin/transport-ledger`（一覧＋フォーム）。退勤送りは既存 `dispatch_legs`(kind=send_home) を使い、`addSendHomeLeg`/`assignSendHomeDriver`/`getSendHomeLegs` を追加、配車ボードに退勤送りセクションを足す。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。設計 4.4・5.3送り台帳・5.1退勤送り。参考モック `.superpowers/brainstorm/1464-1789071838/content/reg-souledger-v2.html`＋`board-redesign-v6.html`（退勤送りセクション）。

---

## 前提
- 最新 = `0034_reservation_car_needs.sql` → 本フェーズ **`0035_transport_ledger.sql`**。
- `dispatch_legs`（0033）は kind に `send_home` を既に持つ（フェーズ4）。`src/domain/dispatch/leg-states.ts` の SEND_STATES/`isValidState('send',...)` を退勤送りにも使う。
- CRUD/一覧＋フォームは `drivers`（`src/lib/drivers/actions.ts`＋`DriversClient.tsx`）を手本。ナビ追加は `admin-nav-model.ts`。
- 脚アクションは `src/lib/dispatch-board/leg-actions.ts`（フェーズ4）に追記。

## File Structure
- Create `migrations/0035_transport_ledger.sql`
- Create `src/lib/transport/actions.ts`（送り台帳 CRUD＋autofill）＋ `tests/integration/ztest-transport-ledger.test.ts`
- Create `src/app/(admin)/admin/transport-ledger/page.tsx` ＋ `TransportLedgerClient.tsx`
- Modify `src/app/(admin)/_components/admin-nav-model.ts`（「受付・配車」に `{ href:"/admin/transport-ledger", label:"送り台帳" }`）
- Modify `src/lib/dispatch-board/leg-actions.ts`（`addSendHomeLeg`/`assignSendHomeDriver`/`getSendHomeLegs`/`deleteSendHomeLeg` 追加）＋ `tests/integration/ztest-send-home-legs.test.ts`
- Modify `src/app/(admin)/admin/dispatch-board/{page.tsx,DispatchBoardClient.tsx}`（退勤送りセクション）

---

## Task 1: マイグレーション 0035

**Files:** Create `migrations/0035_transport_ledger.sql`

```sql
-- 0035_transport_ledger: 送り台帳（設計 4.4）。女性ごとの送り先＋往復時間＋備考。
-- RLS: 参照/書込 = owner/admin/reception（配車運用データ）。

do $$
begin
  if not exists (select 1 from pg_type where typname = 'transport_kind') then
    create type transport_kind as enum ('home', 'dorm', 'stay');
  end if;
end $$;

create table if not exists therapist_transport (
  id           uuid primary key default gen_random_uuid(),
  therapist_id uuid not null references therapists (id) on delete cascade,
  brand_id     uuid not null default 'cccccccc-0000-4000-9000-000000000001'
                 references brands (id) on delete restrict,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint therapist_transport_uniq unique (therapist_id)
);

create table if not exists therapist_transport_routes (
  id             uuid primary key default gen_random_uuid(),
  transport_id   uuid not null references therapist_transport (id) on delete cascade,
  kind           transport_kind not null default 'home',
  destination    text not null,
  round_trip_min int,
  sort_order     int not null default 0,
  constraint transport_routes_min_check check (round_trip_min is null or round_trip_min >= 0)
);

create index if not exists transport_routes_transport_idx on therapist_transport_routes (transport_id);

drop trigger if exists therapist_transport_set_updated_at on therapist_transport;
create trigger therapist_transport_set_updated_at
  before update on therapist_transport
  for each row execute function set_updated_at();

alter table therapist_transport enable row level security;
alter table therapist_transport force row level security;
alter table therapist_transport_routes enable row level security;
alter table therapist_transport_routes force row level security;

drop policy if exists therapist_transport_staff on therapist_transport;
create policy therapist_transport_staff on therapist_transport
  for all using (app_current_role() in ('owner','admin','reception'))
  with check (app_current_role() in ('owner','admin','reception'));
drop policy if exists transport_routes_staff on therapist_transport_routes;
create policy transport_routes_staff on therapist_transport_routes
  for all using (app_current_role() in ('owner','admin','reception'))
  with check (app_current_role() in ('owner','admin','reception'));

grant select, insert, update, delete on therapist_transport to app_runtime;
grant select, insert, update, delete on therapist_transport_routes to app_runtime;
```

- [ ] Run `pnpm db:migrate` → 適用。
- [ ] `git add migrations/0035_transport_ledger.sql && git commit -m "feat(dispatch): therapist_transport(_routes)（送り台帳）マスタを追加"`

---

## Task 2: 送り台帳 Server Actions ＋ 統合テスト（TDD）

**Files:** Create `src/lib/transport/actions.ts`, `tests/integration/ztest-transport-ledger.test.ts`

仕様（manage_reservations で参照・manage_reservations で書込＝reception も配車運用のため可）:
- `listTransportLedger()`: 送り設定のある therapist を `{ therapistId, therapistName, note, routes:[{id,kind,destination,roundTripMin,sortOrder}] }[]` で返す。
- `getTransportForTherapist(therapistId)`: 1件（退勤送りの autofill 用）。
- `saveTransport({ therapistId, note, routes:[{kind,destination,roundTripMin}] })`: therapist_transport を upsert（note）→ routes 全削除→再挿入（トランザクション）。
- `deleteTransport(therapistId)`: 削除。

- [ ] **Step 1: 失敗するテスト** — `ztest-transport-ledger.test.ts`（drivers/shift のテスト構造に倣う。aoi therapist を使い、saveTransport→listTransportLedger/getTransportForTherapist で往復時間・kind・note・複数routeを検証。afterAll で therapist_transport を削除＝cascade で routes も消える）。テストは 4〜5 ケース。実 Postgres 直結・`vi.mock('next/cache')`。owner=ADMIN_DEV_SESSION 経由（getDevSession）。

- [ ] **Step 2:** Run → FAIL。

- [ ] **Step 3: 実装** — `src/lib/transport/actions.ts`。`drivers/actions.ts` と同じ枠（getDevSession/can/getClient/withUser/ActionResult/Zod/revalidatePath('/admin/transport-ledger')）。`saveTransport` は upsert＋routes 入替をトランザクションで。型:

```ts
export interface TransportRoute { id?: string; kind: 'home'|'dorm'|'stay'; destination: string; roundTripMin: number | null; sortOrder?: number; }
export interface TransportLedgerRow { therapistId: string; therapistName: string; note: string | null; routes: TransportRoute[]; }
```
`listTransportLedger` は `therapist_transport` join `therapists`（表示名は seed の名前 or slug。既存 board が `entity_records.published->>'name'` を使うのでそれに倣う: `left join entity_records er on er.entity='therapist' and er.slug=t.slug` → `er.published->>'name'`。無ければ slug）。routes は sort_order/id 順。

- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/lib/transport/actions.ts tests/integration/ztest-transport-ledger.test.ts && git commit -m "feat(dispatch): 送り台帳 CRUD＋autofill＋統合テスト"`

---

## Task 3: 送り台帳 登録画面 ＋ ナビ

**Files:** Create `src/app/(admin)/admin/transport-ledger/{page.tsx,TransportLedgerClient.tsx}`; Modify `admin-nav-model.ts`

参考 `reg-souledger-v2.html`。左＝女性一覧（検索）＋右＝編集フォーム（女性選択＝セラピスト紐付けプルダウン・**送り先複数行**〔種別 home/dorm/stay＋送り先＋往復分〕追加/削除・備考）。`DriversClient` の state 運用に倣う。保存=`saveTransport`、削除=`deleteTransport`。ナビ「受付・配車」に「送り台帳」追加。セラピスト一覧は既存の取得（例: `listDrivers` に相当する therapist 取得。既存 `src/lib/therapist/*` or entity_records から公開/在籍セラピストを引く。無ければ `saveTransport` は therapistId を受けるので、簡易にセラピスト slug/name 一覧を返す薄い action を transport/actions.ts に `listTherapistsForLedger()` として足してよい）。

- [ ] **Step 1:** `listTherapistsForLedger()`（transport/actions.ts に追加・therapists＋表示名一覧）。
- [ ] **Step 2:** page.tsx＋TransportLedgerClient.tsx 実装。
- [ ] **Step 3:** ナビ追加。
- [ ] **Step 4:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 5:** `git add "src/app/(admin)/admin/transport-ledger" "src/app/(admin)/_components/admin-nav-model.ts" src/lib/transport/actions.ts && git commit -m "feat(dispatch): 送り台帳 登録画面（一覧＋複数送り先フォーム）＋ナビ"`

---

## Task 4: 退勤送り（send_home）脚アクション ＋ テスト（TDD）

**Files:** Modify `src/lib/dispatch-board/leg-actions.ts`; Create `tests/integration/ztest-send-home-legs.test.ts`

仕様（manage_reservations）:
- `addSendHomeLeg({ therapistId, dateISO, departAtISO?, destinationText, roundTripMin?, memo? })`: kind=send_home の脚を insert（reservation_id=null・state='予定'・work_date=dateISO）。返り legId。
- `assignSendHomeDriver({ legId, driverId })`: driver をセット＋state='予定'（上書き）。
- `getSendHomeLegs(dateISO, includeFinished=false)`: 当日の send_home 脚を `{ id, therapistId, therapistName, destinationText, roundTripMin, departAtISO, driverId, driverName, vehicleColorHex, vehicleColorName, vehicleNumber, state, memo, isFinished }[]` で返す。
- `finishSendHomeLeg({ legId })`: state='完了' の時のみ is_finished=true。
- `deleteSendHomeLeg({ legId })`: 削除（誤登録の取り消し）。
- 状態変更は既存 `setLegState({legId, slot:'send', state})` を流用（send_home は送り状態）。

- [ ] **Step 1: 失敗するテスト** `ztest-send-home-legs.test.ts`: driver＋therapist(aoi) を用意→addSendHomeLeg→getSendHomeLegs で往復/送り先/therapistName 検証→assignSendHomeDriver→setLegState('完了')→finishSendHomeLeg→includeFinished=false で消える→deleteSendHomeLeg。5〜6 ケース。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3: 実装** leg-actions.ts に上記を追加（既存 import/パターン再利用。`getSendHomeLegs` は `dispatch_legs` where kind='send_home' and work_date=date、left join drivers・left join therapists(＋entity_records で表示名)）。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5:** `git add src/lib/dispatch-board/leg-actions.ts tests/integration/ztest-send-home-legs.test.ts && git commit -m "feat(dispatch): 退勤送り(send_home)脚の追加/割当/取得/終了/削除＋テスト"`

---

## Task 5: 配車ボードに退勤送りセクション

**Files:** Modify `src/app/(admin)/admin/dispatch-board/{page.tsx,DispatchBoardClient.tsx}`

参考 `board-redesign-v6.html` の退勤送りセクション。要件:
- 予約配車テーブルの下に**「退勤送り（自宅・寮）」セクション**（send_home 脚の一覧）。列: 女性 / 送り先（方面）/ 往復(分) / 出発 / 送り車（D&D＋状態＋送りLINEプレースホルダ）/ メモ / 終了。
- **手動追加**: 「＋ 退勤送りを追加」→ 女性選択（`listTherapistsForLedger`）→ 選ぶと `getTransportForTherapist` で送り先・往復・備考を autofill（`therapist_transport_routes` の先頭 or 選択）→ 出発時刻入力 → `addSendHomeLeg`。
- 送り車は右レール（当日出勤ドライバー）から D&D→`assignSendHomeDriver`。状態プルダウンは SEND_STATES→`setLegState(slot:'send')`。終了→`finishSendHomeLeg`（一覧から消える・「終了分も表示」トグルに追従）。削除ボタン→`deleteSendHomeLeg`。
- page.tsx で `getSendHomeLegs(date)` を取得し client へ。日付変更で再取得。

- [ ] **Step 1:** page.tsx に send_home 取得追加。
- [ ] **Step 2:** DispatchBoardClient に退勤送りセクション＋手動追加フォーム実装。
- [ ] **Step 3:** Run `pnpm typecheck && pnpm lint && pnpm build` → 成功。
- [ ] **Step 4:** `git add "src/app/(admin)/admin/dispatch-board" && git commit -m "feat(dispatch): 配車ボードに退勤送りセクション（手動追加・送り台帳autofill）"`

---

## Task 6: フェーズ検証
- [ ] Run `pnpm test` → 全 PASS（ztest-transport-ledger・ztest-send-home-legs 込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 設計4.4（送り台帳）=Task1-3、5.1退勤送り=Task4-5。send_home 脚はフェーズ4の型を使用。
- Placeholder: migration/actions/test は具体化。UI（Task3/5）は既存 DriversClient/DispatchBoardClient 拡張＋モック参照＋要件明示。テストは「drivers/shift の構造に倣う」具体指示。
- 型整合: `TransportRoute`/`TransportLedgerRow`/`saveTransport`/`getTransportForTherapist`/`listTherapistsForLedger`（Task2-3）を UI が使用。`addSendHomeLeg`/`assignSendHomeDriver`/`getSendHomeLegs`/`finishSendHomeLeg`/`deleteSendHomeLeg`（Task4）を Task5 UI が使用。`setLegState(slot:'send')` を send_home に流用。
- リスク: leg-actions.ts への追記は既存 export を壊さない（追加のみ）。board UI はフェーズ4/5 の挙動を保持しセクション追加。
