-- 0006_courses_options_hotels: コース・オプション・ホテルマスタ（フェーズ7 / spec 3-4・8-2・18-1・18-2）
--
-- 設計の骨子:
--   courses  = コース（60/90/120/150分）。金額はすべて整数（円）。小数禁止。
--   options  = コースとは別の実体（spec 3-4。カスタムフィールドの仕組みは使わない）。
--              duration_min が空き枠計算の施術時間 L に効く（L = コース + オプション合計 / spec 5-3）。
--              back_type/back_value はセラピストへのバック（'fixed'=固定円 / 'rate'=率%）。
--   option_availability = オプションの対応セラピスト。**行が無ければ全員対応**（spec 3-4）。
--   hotels   = ホテルマスタ（spec 8-2 ★）。extra_minutes（到着から部屋までの追加時間）を
--              到着バッファに加算する（domain の arrivalExtraMinutes / arrivalBuffers）。
--              is_blocked のホテルは予約を作らせない（公開側でも選べない）。
--
-- reservation_options（予約に付いたオプション）はここでは作らない:
--   reservations が入るフェーズ11で (reservation_id, option_id,
--   price_snapshot, duration_snapshot, back_snapshot) として追加する。
--   **価格・時間・バックは予約時に必ずスナップショットする**（spec 3-4）。
--   後からオプションの値段・時間・バックを変えても、過去の予約・報酬計算は変わらない。
--
-- RLS 必須セット（docs/auth-rls.md §4）:
--   enable row level security + force row level security + ポリシー + app_runtime grant。
--   公開側（料金表・ホテル選択）は既存パターンどおり getClient（BYPASSRLS）で
--   公開可能な行・列（is_active / is_public / not is_blocked）だけを直読みする。

-- ---------------------------------------------------------------------------
-- オプションのバック種別 enum（spec 3-4: 'fixed' = 固定額（円） / 'rate' = 率（%））
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'option_back_type') then
    create type option_back_type as enum ('fixed', 'rate');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- courses: コース（spec 4章・18-1）
-- price / nomination_fee_default は整数（円）。小数は使わない（CLAUDE.md 禁止事項）。
-- nomination_fee_default は通常指名料の既定値（spec 18-3: ¥1,000。個人別の特別指名は
-- therapist 側の設定で上書きする。therapist_courses はフェーズ8/9で追加）。
-- ---------------------------------------------------------------------------
create table if not exists courses (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null unique,
  duration_min            integer not null
                          constraint courses_duration_check check (duration_min > 0),
  price                   integer not null
                          constraint courses_price_check check (price >= 0),
  nomination_fee_default  integer not null default 0
                          constraint courses_nomination_fee_check check (nomination_fee_default >= 0),
  sort_order              integer not null default 0,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists courses_sort_order_idx on courses (sort_order);

drop trigger if exists courses_set_updated_at on courses;
create trigger courses_set_updated_at
  before update on courses
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- options: オプション（spec 3-4・18-2）
-- duration_min は施術時間への加算（0 も可。アロマ等の時間を延ばさないオプション）。
-- back_value の解釈は back_type に依存: 'fixed' なら円（整数）、'rate' なら %（整数）。
-- ---------------------------------------------------------------------------
create table if not exists options (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  description   text,
  price         integer not null
                constraint options_price_check check (price >= 0),
  duration_min  integer not null default 0
                constraint options_duration_check check (duration_min >= 0),
  back_type     option_back_type not null default 'rate',
  back_value    integer not null default 0
                constraint options_back_value_check check (
                  back_value >= 0
                  and (back_type <> 'rate' or back_value <= 100)
                ),
  is_public     boolean not null default true,
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists options_sort_order_idx on options (sort_order);

drop trigger if exists options_set_updated_at on options;
create trigger options_set_updated_at
  before update on options
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- option_availability: オプションの対応セラピスト（spec 3-4）
-- **あるオプションについて行が1つも無ければ「全員対応」**。行があれば列挙した
-- セラピストのみ対応（判定は domain / フェーズ9 の空き枠エンジン側で行う）。
-- ---------------------------------------------------------------------------
create table if not exists option_availability (
  option_id     uuid not null references options (id) on delete cascade,
  therapist_id  uuid not null references therapists (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (option_id, therapist_id)
);

-- ---------------------------------------------------------------------------
-- hotels: ホテルマスタ（spec 8-2 ★）
-- extra_minutes = 到着から部屋までの追加時間（分・整数）。大型ホテルは
-- エントランスから部屋まで10分かかる。**到着バッファに加算する**（完了条件）。
-- is_blocked = 入館お断りの施設。予約を作らせない・公開側でも選べない。
-- area_id / location は null 可: 電話中の「その場で仮登録」（spec 8-2。電話を
-- 止めない）では名前だけで作り、後から情報を補完する運用のため。
-- ---------------------------------------------------------------------------
create table if not exists hotels (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  name_kana      text,
  address        text,
  location       geography(point, 4326),
  area_id        uuid references areas (id) on delete set null,
  entry_note     text,      -- フロント経由が必要 / 直接部屋へ可
  parking_note   text,      -- 駐車場の有無・料金・距離
  extra_minutes  integer not null default 0
                 constraint hotels_extra_minutes_check check (extra_minutes >= 0),
  is_blocked     boolean not null default false,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 1〜2文字からの予測入力（spec 8-2）: 前方一致検索用の演算子クラス付き index
create index if not exists hotels_name_prefix_idx on hotels (name text_pattern_ops);
create index if not exists hotels_name_kana_prefix_idx on hotels (name_kana text_pattern_ops);
create index if not exists hotels_area_id_idx on hotels (area_id);
create index if not exists hotels_location_gist_idx on hotels using gist (location);

drop trigger if exists hotels_set_updated_at on hotels;
create trigger hotels_set_updated_at
  before update on hotels
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS（全テーブル共通の方針 / docs/auth-rls.md §4）:
--   owner/admin  = 全操作（料金表・オプション・ホテルは CMS 管理対象）
--   reception    = select（電話受付で料金・ホテルを参照する）
--   therapist    = select（自分の対応オプション・訪問先ホテルの把握に必要）
--   公開側       = getClient（BYPASSRLS）直読みのためポリシー不要
-- 注: spec 8-2 の「電話中の仮登録」で reception に hotels の insert/update を
--     許すポリシーはオーダーエントリーのフェーズ12で追加する（現時点は select のみ）。
-- ---------------------------------------------------------------------------

-- courses
alter table courses enable row level security;
alter table courses force row level security;
drop policy if exists courses_owner_admin on courses;
create policy courses_owner_admin on courses
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists courses_staff_select on courses;
create policy courses_staff_select on courses
  for select using (app_current_role() in ('reception', 'therapist'));

-- options
alter table options enable row level security;
alter table options force row level security;
drop policy if exists options_owner_admin on options;
create policy options_owner_admin on options
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists options_staff_select on options;
create policy options_staff_select on options
  for select using (app_current_role() in ('reception', 'therapist'));

-- option_availability
alter table option_availability enable row level security;
alter table option_availability force row level security;
drop policy if exists option_availability_owner_admin on option_availability;
create policy option_availability_owner_admin on option_availability
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists option_availability_staff_select on option_availability;
create policy option_availability_staff_select on option_availability
  for select using (app_current_role() in ('reception', 'therapist'));

-- hotels
alter table hotels enable row level security;
alter table hotels force row level security;
drop policy if exists hotels_owner_admin on hotels;
create policy hotels_owner_admin on hotels
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists hotels_staff_select on hotels;
create policy hotels_staff_select on hotels
  for select using (app_current_role() in ('reception', 'therapist'));

-- ---------------------------------------------------------------------------
-- app_runtime への grant
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on courses to app_runtime;
grant select, insert, update, delete on options to app_runtime;
grant select, insert, update, delete on option_availability to app_runtime;
grant select, insert, update, delete on hotels to app_runtime;
