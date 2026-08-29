-- 0005_areas_travel: エリア・徒歩/車の移動時間・バッファ（フェーズ6 / spec 3-8・4章・5-1・5-2）
--
-- 設計の骨子（spec 5-1: 徒歩と車を同じ仕組みで扱わない）:
--   徒歩 = PostGIS で毎回計算（マトリクスにしない）。
--          徒歩時間(分) = 直線距離(m) × 迂回係数 ÷ 分速（walk_settings）。
--          上限（cap_meters）超で車に切替。川・線路等の分断区間は walk_overrides で個別上書き。
--   車   = エリア間マトリクス（area_travel_times） + 時間帯係数（travel_time_modifiers）。
--          深夜は係数 < 1（道が空く）。朝夕は 1.3〜1.5。
--          未登録エリア間は直線距離×係数の暫定値（domain 側 provisionalCarMinutes）。
--   バッファ（spec 5-2）= travel_buffers。駐車バッファは車のみ。エリア別上書き可。
--
-- RLS 必須セット（docs/auth-rls.md §4）:
--   enable row level security
--   force row level security
--   ポリシー
--   app_runtime への grant
--
-- 公開側は既存パターン（src/lib/public/queries.ts）どおり getClient（BYPASSRLS）で
-- 公開可能な列だけを直読みするため、匿名向けポリシーは張らない。

-- ---------------------------------------------------------------------------
-- areas: エリア（区・市・駅単位 / spec 3-8・4章）
-- center は徒歩距離計算・車マトリクス未登録時の暫定値算出に使う代表点。
-- ---------------------------------------------------------------------------
create table if not exists areas (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  kind        text not null
              constraint areas_kind_check check (kind in ('ward', 'city', 'station')),
  center      geography(point, 4326),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists areas_center_gist_idx on areas using gist (center);
create index if not exists areas_sort_order_idx on areas (sort_order);

drop trigger if exists areas_set_updated_at on areas;
create trigger areas_set_updated_at
  before update on areas
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- area_travel_times: 車のエリア間移動時間マトリクス（spec 5-1 ★）
-- 初期値は手動/暫定（Distance Matrix API は未キー）。CMS で人手上書きが正。
-- from = to（同一エリア内の車移動）も許す。
-- ---------------------------------------------------------------------------
create table if not exists area_travel_times (
  from_area_id  uuid not null references areas (id) on delete cascade,
  to_area_id    uuid not null references areas (id) on delete cascade,
  minutes       integer not null
                constraint area_travel_times_minutes_check check (minutes >= 0),
  updated_at    timestamptz not null default now(),
  primary key (from_area_id, to_area_id)
);

drop trigger if exists area_travel_times_set_updated_at on area_travel_times;
create trigger area_travel_times_set_updated_at
  before update on area_travel_times
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- walk_settings: 徒歩の迂回係数・分速・上限距離（spec 5-1。単一行 / CMS で調整可）
-- id は boolean 単一行パターン（true 固定）。2行目は PK 衝突で入らない。
-- ---------------------------------------------------------------------------
create table if not exists walk_settings (
  id               boolean primary key default true
                   constraint walk_settings_singleton check (id),
  detour_factor    numeric(4, 2) not null default 1.30
                   constraint walk_settings_detour_check check (detour_factor >= 1.0),
  speed_m_per_min  integer not null default 80
                   constraint walk_settings_speed_check check (speed_m_per_min > 0),
  cap_meters       integer not null default 1600
                   constraint walk_settings_cap_check check (cap_meters >= 0),
  updated_at       timestamptz not null default now()
);

drop trigger if exists walk_settings_set_updated_at on walk_settings;
create trigger walk_settings_set_updated_at
  before update on walk_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- walk_overrides: 区間ごとの徒歩時間上書き（橋・踏切・幹線道路の分断 / spec 5-1）
-- 迂回係数が効かない区間に「+N分」を積む例外テーブル。区間はエリア対で持つ。
-- ---------------------------------------------------------------------------
create table if not exists walk_overrides (
  id             uuid primary key default gen_random_uuid(),
  from_area_id   uuid not null references areas (id) on delete cascade,
  to_area_id     uuid not null references areas (id) on delete cascade,
  added_minutes  integer not null,
  note           text,                     -- 例:「橋を渡るため +12分」
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint walk_overrides_pair_unique unique (from_area_id, to_area_id)
);

drop trigger if exists walk_overrides_set_updated_at on walk_overrides;
create trigger walk_overrides_set_updated_at
  before update on walk_overrides
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- travel_time_modifiers: 車の時間帯係数（spec 5-1）
-- 深夜は multiplier < 1（0.75〜）、朝夕は 1.3〜1.5。additional は分の加算。
-- time_from > time_to の行は日跨ぎ（例 23:00〜05:00）として扱う（domain 側で解釈）。
-- ---------------------------------------------------------------------------
create table if not exists travel_time_modifiers (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  time_from   time not null,
  time_to     time not null,
  multiplier  numeric(4, 2) not null default 1.00
              constraint travel_time_modifiers_multiplier_check check (multiplier > 0),
  additional  integer not null default 0,
  sort_order  integer not null default 0,
  updated_at  timestamptz not null default now()
);

drop trigger if exists travel_time_modifiers_set_updated_at on travel_time_modifiers;
create trigger travel_time_modifiers_set_updated_at
  before update on travel_time_modifiers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- bases: 待機場所（自宅・最寄り駅・事務所 / spec 4章・5-3）
-- shifts（フェーズ8）の待機開始/終了場所として参照される。
-- ---------------------------------------------------------------------------
create table if not exists bases (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  kind        text not null
              constraint bases_kind_check check (kind in ('home', 'station', 'office')),
  location    geography(point, 4326),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists bases_location_gist_idx on bases using gist (location);

drop trigger if exists bases_set_updated_at on bases;
create trigger bases_set_updated_at
  before update on bases
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- travel_buffers: 移動バッファ（spec 5-2）
-- 既定1行（scope='default'）+ エリア別上書き（scope='area'）。
-- parking_min（駐車）は車のときだけ加算する（適用は domain の travelBuffers）。
-- ---------------------------------------------------------------------------
create table if not exists travel_buffers (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null
               constraint travel_buffers_scope_check check (scope in ('default', 'area')),
  area_id      uuid references areas (id) on delete cascade,
  arrive_min   integer not null default 10
               constraint travel_buffers_arrive_check check (arrive_min >= 0),
  parking_min  integer not null default 15
               constraint travel_buffers_parking_check check (parking_min >= 0),
  before_min   integer not null default 5
               constraint travel_buffers_before_check check (before_min >= 0),
  after_min    integer not null default 10
               constraint travel_buffers_after_check check (after_min >= 0),
  updated_at   timestamptz not null default now(),
  -- scope と area_id の整合: default は area_id なし、area は必須
  constraint travel_buffers_scope_area_check check (
    (scope = 'default' and area_id is null)
    or (scope = 'area' and area_id is not null)
  )
);

-- 既定行は1つだけ / エリア上書きはエリアごとに1つだけ
create unique index if not exists travel_buffers_default_unique
  on travel_buffers (scope) where scope = 'default';
create unique index if not exists travel_buffers_area_unique
  on travel_buffers (area_id) where area_id is not null;

drop trigger if exists travel_buffers_set_updated_at on travel_buffers;
create trigger travel_buffers_set_updated_at
  before update on travel_buffers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS（全テーブル共通の方針）:
--   owner/admin  = 全操作（エリア管理・マトリクス・係数・バッファは CMS 管理対象 / spec 3-8）
--   reception    = select（電話受付で空き枠・エリアを参照する）
--   therapist    = select（自分の予定・移動時間の把握に必要）
--   公開側       = getClient（BYPASSRLS）直読みのためポリシー不要
-- ---------------------------------------------------------------------------

-- areas
alter table areas enable row level security;
alter table areas force row level security;
drop policy if exists areas_owner_admin on areas;
create policy areas_owner_admin on areas
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists areas_staff_select on areas;
create policy areas_staff_select on areas
  for select using (app_current_role() in ('reception', 'therapist'));

-- area_travel_times
alter table area_travel_times enable row level security;
alter table area_travel_times force row level security;
drop policy if exists area_travel_times_owner_admin on area_travel_times;
create policy area_travel_times_owner_admin on area_travel_times
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists area_travel_times_staff_select on area_travel_times;
create policy area_travel_times_staff_select on area_travel_times
  for select using (app_current_role() in ('reception', 'therapist'));

-- walk_settings
alter table walk_settings enable row level security;
alter table walk_settings force row level security;
drop policy if exists walk_settings_owner_admin on walk_settings;
create policy walk_settings_owner_admin on walk_settings
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists walk_settings_staff_select on walk_settings;
create policy walk_settings_staff_select on walk_settings
  for select using (app_current_role() in ('reception', 'therapist'));

-- walk_overrides
alter table walk_overrides enable row level security;
alter table walk_overrides force row level security;
drop policy if exists walk_overrides_owner_admin on walk_overrides;
create policy walk_overrides_owner_admin on walk_overrides
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists walk_overrides_staff_select on walk_overrides;
create policy walk_overrides_staff_select on walk_overrides
  for select using (app_current_role() in ('reception', 'therapist'));

-- travel_time_modifiers
alter table travel_time_modifiers enable row level security;
alter table travel_time_modifiers force row level security;
drop policy if exists travel_time_modifiers_owner_admin on travel_time_modifiers;
create policy travel_time_modifiers_owner_admin on travel_time_modifiers
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists travel_time_modifiers_staff_select on travel_time_modifiers;
create policy travel_time_modifiers_staff_select on travel_time_modifiers
  for select using (app_current_role() in ('reception', 'therapist'));

-- bases
alter table bases enable row level security;
alter table bases force row level security;
drop policy if exists bases_owner_admin on bases;
create policy bases_owner_admin on bases
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists bases_staff_select on bases;
create policy bases_staff_select on bases
  for select using (app_current_role() in ('reception', 'therapist'));

-- travel_buffers
alter table travel_buffers enable row level security;
alter table travel_buffers force row level security;
drop policy if exists travel_buffers_owner_admin on travel_buffers;
create policy travel_buffers_owner_admin on travel_buffers
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists travel_buffers_staff_select on travel_buffers;
create policy travel_buffers_staff_select on travel_buffers
  for select using (app_current_role() in ('reception', 'therapist'));

-- ---------------------------------------------------------------------------
-- app_runtime への grant
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on areas to app_runtime;
grant select, insert, update, delete on area_travel_times to app_runtime;
grant select, insert, update, delete on walk_settings to app_runtime;
grant select, insert, update, delete on walk_overrides to app_runtime;
grant select, insert, update, delete on travel_time_modifiers to app_runtime;
grant select, insert, update, delete on bases to app_runtime;
grant select, insert, update, delete on travel_buffers to app_runtime;
