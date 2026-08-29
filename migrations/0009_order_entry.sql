-- 0009_order_entry: フェーズ12 電話受付・不成立ログ・電話確認フロー

-- reservation_source enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'reservation_source') then
    create type reservation_source as enum ('web', 'phone');
  end if;
end $$;

-- reservations に新列を追加（idempotent）
alter table reservations
  add column if not exists phone_confirmed_at timestamptz,
  add column if not exists phone_confirmed_by uuid references app_users(id) on delete set null,
  add column if not exists source reservation_source not null default 'web';

-- lost_order_reason enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'lost_order_reason') then
    create type lost_order_reason as enum ('time','area','nomination','price','other');
  end if;
end $$;

-- lost_orders table
create table if not exists lost_orders (
  id         uuid primary key default gen_random_uuid(),
  phone      text,
  area_id    uuid references areas(id) on delete set null,
  reason     lost_order_reason not null,
  note       text,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- call_result enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'call_result') then
    create type call_result as enum ('confirmed','no_answer','other');
  end if;
end $$;

-- call_logs table
create table if not exists call_logs (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid references reservations(id) on delete set null,
  phone          text,
  result         call_result not null,
  note           text,
  called_by      uuid references app_users(id) on delete set null,
  called_at      timestamptz not null default now()
);

-- RLS for lost_orders
alter table lost_orders enable row level security;
alter table lost_orders force row level security;

drop policy if exists lost_orders_staff_all on lost_orders;
create policy lost_orders_staff_all on lost_orders
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- RLS for call_logs
alter table call_logs enable row level security;
alter table call_logs force row level security;

drop policy if exists call_logs_staff_all on call_logs;
create policy call_logs_staff_all on call_logs
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- Grant to app_runtime
grant select, insert, update, delete on lost_orders, call_logs to app_runtime;
