-- 0032_driver_shifts: ドライバー週次シフト（設計 4.3）。
-- 週=月曜始まり。時刻は当日00:00からの分（25時超え可＝1440超を許容）。
-- memo は「消すまで翌週へ引き継ぐシフトメモ」（引継ぎはアプリ層で解決）。
-- RLS: 参照 = owner/admin/reception、書込 = owner/admin。

create table if not exists driver_shift_weeks (
  id          uuid primary key default gen_random_uuid(),
  driver_id   uuid not null references drivers (id) on delete cascade,
  week_start  date not null,          -- 月曜
  memo        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint driver_shift_weeks_uniq unique (driver_id, week_start)
);

create table if not exists driver_shift_days (
  id         uuid primary key default gen_random_uuid(),
  week_id    uuid not null references driver_shift_weeks (id) on delete cascade,
  dow        smallint not null,       -- 0=月 .. 6=日
  start_min  int not null,            -- 当日0:00からの分（0..2879）
  end_min    int not null,
  constraint driver_shift_days_dow_check check (dow between 0 and 6),
  constraint driver_shift_days_min_check check (start_min >= 0 and end_min > start_min and end_min <= 2879),
  constraint driver_shift_days_uniq unique (week_id, dow)
);

create index if not exists driver_shift_days_week_idx on driver_shift_days (week_id);

drop trigger if exists driver_shift_weeks_set_updated_at on driver_shift_weeks;
create trigger driver_shift_weeks_set_updated_at
  before update on driver_shift_weeks
  for each row execute function set_updated_at();

alter table driver_shift_weeks enable row level security;
alter table driver_shift_weeks force row level security;
alter table driver_shift_days  enable row level security;
alter table driver_shift_days  force row level security;

drop policy if exists driver_shift_weeks_read on driver_shift_weeks;
create policy driver_shift_weeks_read on driver_shift_weeks
  for select using (app_current_role() in ('owner','admin','reception'));
drop policy if exists driver_shift_weeks_write on driver_shift_weeks;
create policy driver_shift_weeks_write on driver_shift_weeks
  for all using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

drop policy if exists driver_shift_days_read on driver_shift_days;
create policy driver_shift_days_read on driver_shift_days
  for select using (app_current_role() in ('owner','admin','reception'));
drop policy if exists driver_shift_days_write on driver_shift_days;
create policy driver_shift_days_write on driver_shift_days
  for all using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

grant select, insert, update, delete on driver_shift_weeks to app_runtime;
grant select, insert, update, delete on driver_shift_days  to app_runtime;
