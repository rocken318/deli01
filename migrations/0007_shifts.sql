-- 0007_shifts: 出勤予定（フェーズ8 / spec 3-3・4章・14章 #8）
--
-- 設計の骨子:
--   shifts       = 出勤「予定」。実績（attendances / spec 3-5）とは混ぜない（後続フェーズ）。
--                  1セラピスト×1日に1行（unique）。分割シフトが必要になったら
--                  unique を外す判断を判断ログに残して行う。
--   shift_areas  = その日に対応できるエリア（spec 3-3「全域とは限らない」）。
--                  公開出勤表（/schedule）のエリア絞り込みと、空き枠エンジン
--                  （spec 5-3 手順2「A が対応エリアに含まれるか」）の両方がここを見る。
--   base_start_id / base_end_id = 待機開始/終了場所（spec 3-3。自宅/最寄り駅/事務所）。
--                  フェーズ9 の gap0（B_start → R1）と gap_n（Rn → B_end「帰れること」）に使う。
--   max_bookings = 1日の最大施術本数（spec 3-3 / 5-3 手順3）。null = 上限なし。
--   is_day_off   = 当日欠勤ワンタップ（spec 3-3「本日休み」）。行を消さず true にする
--                  （予定があった事実を残し、既存予約の振替導線につなげる）。
--
-- あわせて therapists にセラピスト個人の移動設定（spec 5-1「セラピストごとの設定」/
-- フェーズ6 判断ログ #15(e) の予告どおり）を追加する:
--   can_use_car     = 車を使えるか（免許・車両）。false なら徒歩圏の予約しか受けない
--   walk_cap_meters = 徒歩上限の個人差。null = walk_settings.cap_meters の既定を使う
--   （どちらも chooseMode(distance, {capMeters, canUseCar}) にそのまま渡す）
--
-- RLS 必須セット（docs/auth-rls.md §4）:
--   enable row level security + force row level security + ポリシー + app_runtime grant

-- ---------------------------------------------------------------------------
-- therapists: 個人の移動設定カラムを追加
-- ---------------------------------------------------------------------------
alter table therapists add column if not exists can_use_car boolean not null default true;
alter table therapists add column if not exists walk_cap_meters integer
  constraint therapists_walk_cap_check check (walk_cap_meters is null or walk_cap_meters > 0);

-- ---------------------------------------------------------------------------
-- shifts: 出勤予定（spec 3-3・4章）
-- work_date は Asia/Tokyo の営業日。start_at/end_at は timestamptz（日跨ぎシフトは
-- end_at が翌日になる。文字列で計算しない / spec 1-2 禁止事項）。
-- ---------------------------------------------------------------------------
create table if not exists shifts (
  id             uuid primary key default gen_random_uuid(),
  therapist_id   uuid not null references therapists (id) on delete cascade,
  work_date      date not null,
  start_at       timestamptz not null,
  end_at         timestamptz not null,
  base_start_id  uuid references bases (id) on delete set null,
  base_end_id    uuid references bases (id) on delete set null,
  max_bookings   integer
                 constraint shifts_max_bookings_check check (max_bookings is null or max_bookings > 0),
  note           text,
  is_day_off     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint shifts_time_order_check check (end_at > start_at),
  -- 1セラピスト×1日に1行（当日欠勤ワンタップ・冪等シードの前提）
  constraint shifts_therapist_day_unique unique (therapist_id, work_date)
);

create index if not exists shifts_work_date_idx on shifts (work_date);
create index if not exists shifts_therapist_date_idx on shifts (therapist_id, work_date);

drop trigger if exists shifts_set_updated_at on shifts;
create trigger shifts_set_updated_at
  before update on shifts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- shift_areas: その日に対応できるエリア（spec 3-3）
-- 出勤していてもここに無いエリアの一覧・空き枠には出ない（spec 15章）。
-- ---------------------------------------------------------------------------
create table if not exists shift_areas (
  shift_id  uuid not null references shifts (id) on delete cascade,
  area_id   uuid not null references areas (id) on delete cascade,
  primary key (shift_id, area_id)
);

create index if not exists shift_areas_area_idx on shift_areas (area_id);

-- ---------------------------------------------------------------------------
-- RLS: shifts
--   owner/admin = 全操作（出勤設定は CMS 管理対象 / spec 3-3・3-8）
--   reception   = select（電話受付で「今日誰が動けるか」を参照する）
--   therapist   = 自分の行のみ select / update（当日欠勤ワンタップ / spec 3-3）。
--                 insert/delete はさせない（シフトの作成・削除は運営）。
--                 update の with check で therapist_id の付け替えも防ぐ。
-- 公開側（/schedule）は既存パターンどおり getClient（BYPASSRLS）で
-- published なセラピストの公開可能な列のみ直読み（src/lib/schedule/queries.ts）。
-- ---------------------------------------------------------------------------
alter table shifts enable row level security;
alter table shifts force row level security;

drop policy if exists shifts_owner_admin on shifts;
create policy shifts_owner_admin on shifts
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists shifts_reception_select on shifts;
create policy shifts_reception_select on shifts
  for select using (app_current_role() = 'reception');

drop policy if exists shifts_self_select on shifts;
create policy shifts_self_select on shifts
  for select using (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  );

drop policy if exists shifts_self_update on shifts;
create policy shifts_self_update on shifts
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

-- ---------------------------------------------------------------------------
-- RLS: shift_areas
--   owner/admin = 全操作、reception = select、therapist = 自分の shift の行のみ select
--   （エリアの付け替えは運営のみ。therapist の update は与えない）
-- ---------------------------------------------------------------------------
alter table shift_areas enable row level security;
alter table shift_areas force row level security;

drop policy if exists shift_areas_owner_admin on shift_areas;
create policy shift_areas_owner_admin on shift_areas
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists shift_areas_reception_select on shift_areas;
create policy shift_areas_reception_select on shift_areas
  for select using (app_current_role() = 'reception');

drop policy if exists shift_areas_self_select on shift_areas;
create policy shift_areas_self_select on shift_areas
  for select using (
    app_current_role() = 'therapist'
    and exists (
      select 1
      from app_users u
      join therapists t on t.id = u.therapist_id
      join shifts s on s.therapist_id = t.id
      where u.id = app_current_user_id()
        and s.id = shift_areas.shift_id
    )
  );

-- ---------------------------------------------------------------------------
-- app_runtime への grant
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on shifts to app_runtime;
grant select, insert, update, delete on shift_areas to app_runtime;
