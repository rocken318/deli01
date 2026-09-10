-- 0031_drivers: ドライバー（人＋車両＋識別色）マスタ（設計 4.2）。
-- 1ドライバー=1車を既定。vehicle_color_hex が配車ボードの識別色。
-- RLS: 参照 = owner/admin/reception（配車で使う）、書込 = owner/admin。

create table if not exists drivers (
  id                 uuid primary key default gen_random_uuid(),
  brand_id           uuid not null default 'cccccccc-0000-4000-9000-000000000001'
                       references brands (id) on delete restrict,
  name               text not null,
  phone              text,
  ng_note            text,
  vehicle_number     text,
  vehicle_model      text,
  vehicle_color_hex  text,
  vehicle_color_name text,
  vehicle_note       text,
  sort_order         int not null default 0,
  is_active          bool not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint drivers_color_hex_check check (
    vehicle_color_hex is null or vehicle_color_hex ~ '^#[0-9A-Fa-f]{6}$'
  )
);

create index if not exists drivers_active_idx on drivers (is_active, sort_order);

drop trigger if exists drivers_set_updated_at on drivers;
create trigger drivers_set_updated_at
  before update on drivers
  for each row execute function set_updated_at();

alter table drivers enable row level security;
alter table drivers force row level security;

drop policy if exists drivers_read on drivers;
create policy drivers_read on drivers
  for select
  using (app_current_role() in ('owner','admin','reception'));

drop policy if exists drivers_write on drivers;
create policy drivers_write on drivers
  for all
  using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

grant select, insert, update, delete on drivers to app_runtime;
