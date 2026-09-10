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
