-- 0013_cancellation_waitlist: フェーズ15 キャンセル・変更 / 当日オプション追加 / キャンセル待ち
--
-- 設計の骨子:
--   - **当日延長の可否判定（完了条件 / spec 3-4 L289・受入 L1100）**は既存の占有区間
--     （depart_at〜free_at）と exclusion 制約 no_therapist_overlap をそのまま使う。延長で
--     free_at が後ろへ伸び、後続予約の depart_at を超えると exclusion が弾く（DB 裁定）。
--     アプリ側は canExtend（純関数）で「押した瞬間の可否」を返す（src/domain/booking/extension.ts）。
--     このマイグレーションでは**スキーマ変更は不要**（延長は既存列の更新）。
--   - キャンセル: reservations に cancelled_at / cancel_reason / cancel_kind を追加。
--     status='cancelled'|'noshow' は exclusion の where から外れて枠が空く（0008）。
--   - キャンセル待ち: waitlists（希望条件の登録。**枠は押さえない**＝先着仮押さえ権なし / spec 5 L660）。
--     通知（メール/LINE）はフェーズ20。本フェーズは登録と staff 閲覧まで。

-- ---------------------------------------------------------------------------
-- キャンセル: reservations に控え列を追加（冪等）
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'cancel_kind') then
    -- customer=顧客都合 / shop=店都合 / noshow=無断キャンセル（spec 11-2 L918-919）
    create type cancel_kind as enum ('customer', 'shop', 'noshow');
  end if;
end $$;

alter table reservations
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists cancel_kind   cancel_kind;

-- ---------------------------------------------------------------------------
-- waitlists: キャンセル待ち（spec 5 L656-660）
--   希望条件（日付・時間帯の範囲・エリア・セラピスト・コース）。枠は押さえない。
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'waitlist_status') then
    create type waitlist_status as enum ('waiting', 'notified', 'closed');
  end if;
end $$;

create table if not exists waitlists (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null,
  customer_id   uuid references customers (id) on delete set null,
  desired_date  date not null,
  time_from     time,                    -- 希望時間帯（開始・任意）
  time_to       time,                    -- 希望時間帯（終了・任意）
  area_id       uuid references areas (id) on delete set null,
  therapist_id  uuid references therapists (id) on delete set null,
  course_id     uuid references courses (id) on delete set null,
  status        waitlist_status not null default 'waiting',
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists waitlists_date_idx on waitlists (desired_date);
create index if not exists waitlists_status_idx on waitlists (status);
create index if not exists waitlists_phone_idx on waitlists (phone);

drop trigger if exists waitlists_set_updated_at on waitlists;
create trigger waitlists_set_updated_at
  before update on waitlists
  for each row execute function set_updated_at();

alter table waitlists enable row level security;
alter table waitlists force row level security;

-- staff（owner/admin/reception）は全操作。公開からの登録は Server Action の特権経路
-- （server-only）で行い、クライアント直 DB は許さない（既存の公開予約作成と同方針）。
-- therapist には見せない（他人の顧客の希望条件は本人に不要）。
drop policy if exists waitlists_staff_all on waitlists;
create policy waitlists_staff_all on waitlists
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- 0001 の default privileges で app_runtime に CRUD は付与済み（waitlists は台帳では
-- ないため revoke しない。編集・クローズを許す）。
