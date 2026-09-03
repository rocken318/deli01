-- 0025_dispatch_ops: 配車運用レイヤー（タクシー会社名簿・伝言板・部屋番号）
--
-- taxi_companies: 配車係が電話時に参照するタクシー会社一覧
-- driver_messages: 全員向けの合同伝言板（追記中心）
-- reservations.room_number: 部屋番号の専用列（addresses.label 流用をやめる）
--
-- RLS:
--   taxi_companies: select = owner/admin/reception/therapist（配車時に参照できる）
--                   write  = owner/admin のみ
--   driver_messages: select/insert = owner/admin/reception（staff）
--                    delete         = owner/admin のみ
--   reservations.room_number: 0008 の reservations_staff_all が新列に自動適用される。
--     therapist 列ガードは 0012 の reservations_therapist_guard トリガが
--     dispatch_* と同様に room_number をブロック列に含めるため別途修正不要（確認済み）。

-- ---------------------------------------------------------------------------
-- 1. taxi_companies
-- ---------------------------------------------------------------------------
create table if not exists taxi_companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  shift_note  text,
  note        text,
  sort_order  int not null default 0,
  is_active   bool not null default true,
  created_at  timestamptz not null default now()
);

alter table taxi_companies enable row level security;
alter table taxi_companies force row level security;

drop policy if exists taxi_companies_read on taxi_companies;
create policy taxi_companies_read on taxi_companies
  for select
  using (app_current_role() in ('owner','admin','reception','therapist'));

drop policy if exists taxi_companies_write on taxi_companies;
create policy taxi_companies_write on taxi_companies
  for all
  using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

grant select, insert, update, delete on taxi_companies to app_runtime;

-- ---------------------------------------------------------------------------
-- 2. driver_messages
-- ---------------------------------------------------------------------------
create table if not exists driver_messages (
  id          uuid primary key default gen_random_uuid(),
  body        text not null,
  created_by  uuid references app_users(id),
  created_at  timestamptz not null default now()
);

alter table driver_messages enable row level security;
alter table driver_messages force row level security;

drop policy if exists driver_messages_staff_read on driver_messages;
create policy driver_messages_staff_read on driver_messages
  for select
  using (app_current_role() in ('owner','admin','reception'));

drop policy if exists driver_messages_staff_insert on driver_messages;
create policy driver_messages_staff_insert on driver_messages
  for insert
  with check (app_current_role() in ('owner','admin','reception'));

drop policy if exists driver_messages_admin_delete on driver_messages;
create policy driver_messages_admin_delete on driver_messages
  for delete
  using (app_current_role() in ('owner','admin'));

grant select, insert, delete on driver_messages to app_runtime;

-- ---------------------------------------------------------------------------
-- 3. reservations.room_number
-- ---------------------------------------------------------------------------
alter table reservations
  add column if not exists room_number text;
-- RLS: 0008 の reservations_staff_all がそのまま新列に適用される。
-- therapist guard (0012) は room_number を保護する（追加の policy/grant 変更は不要）。
