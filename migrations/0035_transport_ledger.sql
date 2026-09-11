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
