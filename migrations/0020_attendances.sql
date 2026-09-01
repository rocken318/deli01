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
