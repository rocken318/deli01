-- 0004_therapists: セラピストマスタ + メディア非公開フラグ（フェーズ4 / spec 3-7・3-8・4章）
--
-- RLS 必須セット（docs/auth-rls.md §4）:
--   enable row level security
--   force row level security
--   ポリシー
--   app_runtime への grant

-- ---------------------------------------------------------------------------
-- therapist_status enum（spec 3-8: ステータス管理）
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'therapist_status') then
    create type therapist_status as enum ('active', 'inactive', 'retired');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- therapists: セラピストマスタ（spec 3-8 / 4章）
-- ---------------------------------------------------------------------------
create table if not exists therapists (
  id             uuid primary key default gen_random_uuid(),
  app_user_id    uuid references app_users (id) on delete set null,
  slug           text unique not null,
  status         therapist_status not null default 'active',
  display_order  integer not null default 0,
  retired_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists therapists_status_idx
  on therapists (status);

create index if not exists therapists_display_order_idx
  on therapists (display_order);

drop trigger if exists therapists_set_updated_at on therapists;
create trigger therapists_set_updated_at
  before update on therapists
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- app_users.therapist_id への外部キー制約を追加（0001 では therapists 未作成だった）
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'app_users_therapist_id_fkey'
      and conrelid = 'app_users'::regclass
  ) then
    alter table app_users
      add constraint app_users_therapist_id_fkey
      foreign key (therapist_id) references therapists (id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- media: is_hidden カラムを追加（spec 3-7: 退職時の一括非公開）
-- ---------------------------------------------------------------------------
alter table media add column if not exists is_hidden boolean not null default false;

-- ---------------------------------------------------------------------------
-- RLS: therapists
-- ---------------------------------------------------------------------------
alter table therapists enable row level security;
alter table therapists force row level security;

-- owner/admin: 全操作
drop policy if exists therapists_owner_admin on therapists;
create policy therapists_owner_admin on therapists
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- reception: select のみ（電話受付でセラピスト一覧を参照する）
drop policy if exists therapists_reception_select on therapists;
create policy therapists_reception_select on therapists
  for select
  using (app_current_role() = 'reception');

-- therapist: 自分の行のみ select
-- app_users の therapist_id が therapists.id と一致する行のみ表示する
drop policy if exists therapists_self_select on therapists;
create policy therapists_self_select on therapists
  for select
  using (
    app_current_role() = 'therapist'
    and id = (
      select therapist_id from app_users
      where id = app_current_user_id()
        and therapist_id is not null
      limit 1
    )
  );

-- ---------------------------------------------------------------------------
-- app_runtime への grant
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on therapists to app_runtime;
