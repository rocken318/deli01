-- 0008_reservations: 予約・仮押さえ・顧客・住所・ファネル計測（フェーズ11 / spec 4章・5-5・6章・9章・付録B-2）
--
-- 設計の骨子:
--   customers        = 顧客。電話番号で名寄せ（spec 9章。unique(phone)）。ログイン必須にしない。
--   addresses        = 顧客の住所（複数可 / 自宅・ホテル）。location は PostGIS geography。
--                      ジオコーディング前は null（フェーズ11 は area 代表点で計算し、
--                      個別座標での再計算は住所ジオコーディング配線後に精緻化）。
--   reservations     = 予約 ★。占有区間は start_at〜end_at ではなく **depart_at〜free_at**。
--                      「移動を挟んで次が入るか」を DB 制約で守る（spec 4章）。
--   no_therapist_overlap = ★最重要の exclusion 制約。アプリのチェックだけでは同時
--                      リクエストで抜けるため、同一セラピストの tstzrange(depart_at, free_at, '[)')
--                      の重複を DB が拒否する（'[)' なので free_at = 次の depart_at の隣接は許す）。
--                      status が held/confirmed/enroute/in_service/done の行だけが占有する
--                      （noshow/cancelled は枠を空ける）。
--   仮押さえ方式（spec 5-5）: **ホールドは reservations に status='held' で insert** し、
--                      exclusion 制約で守る（別テーブルのロックでは同時 insert の競合を
--                      DB が裁定できない）。slot_holds は session_id / expires_at の追跡用に
--                      併設し、期限切れ解放（release_expired_holds()）と「自分のホールドか」の
--                      確認に使う。held 行は必ず slot_holds を 1 行伴う。
--   version          = 楽観ロック（spec 4章・15章）。update は必ず
--                      `where id = $1 and version = $2` + `set version = version + 1`。
--                      0 行更新 = 競合として拒否する。
--   reservation_options = 予約時点の価格・時間・バックのスナップショット（spec 3-4。
--                      後からオプション設定を変えても過去の予約は変わらない）。
--                      back は back_type + back_value の 2 列で控える（金額は整数円。
--                      jsonb にしない = 集計・報酬計算で型を保証するため）。
--   funnel_events    = 予約ファネル計測（付録B-2「訪問→セラピスト閲覧→枠選択→仮押さえ→確定」）。
--                      追記専用。session_id は公開側の匿名セッション（個人情報を持たない）。
--
-- RLS 必須セット（docs/auth-rls.md §4）:
--   enable + force + ポリシー + app_runtime grant。
--   顧客住所は機微情報（spec 13-3）。本フェーズは owner/admin/reception = 可、
--   therapist = 自分の担当予約に紐づく行のみ select（180 分ゲート + 監査はフェーズ14/16 で
--   domain の can() と合わせて精緻化）。公開側の予約作成は Server Action（サーバ専用モジュール）
--   経由の特権接続で行い、入力は Zod で検証する（クライアントから直接 DB は触らない）。

-- 0000 で作成済みのはずだが冪等に（exclusion 制約の uuid 等値比較に必要）
create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'reservation_status') then
    create type reservation_status as enum
      ('held', 'confirmed', 'enroute', 'in_service', 'done', 'noshow', 'cancelled');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'address_kind') then
    create type address_kind as enum ('home', 'hotel');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'funnel_step') then
    create type funnel_step as enum
      ('visit', 'view_therapist', 'select_slot', 'hold', 'confirm');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- customers: 顧客（spec 9章）
-- 電話番号で名寄せ（unique）。ログイン必須にしない。ポイント/ランクはフェーズ16。
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null unique
              constraint customers_phone_check check (phone ~ '^0[0-9]{9,10}$'),
  name        text not null,
  name_kana   text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists customers_set_updated_at on customers;
create trigger customers_set_updated_at
  before update on customers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- addresses: 顧客の住所（spec 9章。複数登録可 / 自宅・ホテル / PostGIS）
-- kind='hotel' は hotel_id 必須。location はジオコーディング後に補完（null 可）。
-- area_id は空き枠計算・エリア集計の基準。
-- ---------------------------------------------------------------------------
create table if not exists addresses (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers (id) on delete cascade,
  kind         address_kind not null,
  hotel_id     uuid references hotels (id) on delete set null,
  label        text,
  detail       text not null,
  location     geography(point, 4326),
  area_id      uuid not null references areas (id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint addresses_hotel_kind_check check (kind <> 'hotel' or hotel_id is not null)
);

create index if not exists addresses_customer_idx on addresses (customer_id);
create index if not exists addresses_area_idx on addresses (area_id);
create index if not exists addresses_location_gist_idx on addresses using gist (location);

drop trigger if exists addresses_set_updated_at on addresses;
create trigger addresses_set_updated_at
  before update on addresses
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- reservations: 予約 ★（spec 4章「reservations の要点」を忠実に）
-- customer_id / address_id は spec 上 not null だが、仮押さえ（status='held'）は
-- 顧客入力前に枠を確保するため null を許し、held 以外では not null を check で強制する
-- （spec 5-5「reservations に status='held' で入れて exclusion 制約で守るのが確実」との整合）。
-- 金額はすべて整数（円）。
-- ---------------------------------------------------------------------------
create table if not exists reservations (
  id              uuid primary key default gen_random_uuid(),
  therapist_id    uuid not null references therapists (id) on delete restrict,
  customer_id     uuid references customers (id) on delete restrict,
  address_id      uuid references addresses (id) on delete restrict,
  area_id         uuid not null references areas (id) on delete restrict,
  course_id       uuid not null references courses (id) on delete restrict,
  hotel_id        uuid references hotels (id) on delete set null,
  start_at        timestamptz not null,   -- 施術開始
  end_at          timestamptz not null,   -- 施術終了
  depart_at       timestamptz not null,   -- 前の場所を出る時刻 ★
  free_at         timestamptz not null,   -- 次へ動ける時刻 ★
  travel_in_min   integer not null
                  constraint reservations_travel_in_check check (travel_in_min >= 0),
  travel_out_min  integer not null
                  constraint reservations_travel_out_check check (travel_out_min >= 0),
  buffer_min      integer not null
                  constraint reservations_buffer_check check (buffer_min >= 0),
  status          reservation_status not null default 'held',
  nomination_fee  integer not null default 0
                  constraint reservations_nomination_fee_check check (nomination_fee >= 0),
  transport_fee   integer not null default 0
                  constraint reservations_transport_fee_check check (transport_fee >= 0),
  total_amount    integer not null default 0
                  constraint reservations_total_amount_check check (total_amount >= 0),
  version         integer not null default 0
                  constraint reservations_version_check check (version >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint reservations_service_order_check check (end_at > start_at),
  constraint reservations_occupy_order_check check (
    depart_at <= start_at and free_at >= end_at
  ),
  -- 確定以降（confirmed/enroute/in_service/done/noshow）は顧客・住所が確定して
  -- いること（spec 4章の not null と 5-5 の held の両立。held は入力前・cancelled は
  -- 期限切れ held からの遷移もあり得るため要求しない）
  constraint reservations_customer_required_check check (
    status in ('held', 'cancelled')
    or (customer_id is not null and address_id is not null)
  )
);

-- ★最重要（spec 4章）: セラピストの時間重複を DB 制約で止める。
-- 占有区間は depart_at〜free_at（'[)' 半開なので free_at = 次の depart_at は重複でない）。
alter table reservations drop constraint if exists no_therapist_overlap;
alter table reservations add constraint no_therapist_overlap
  exclude using gist (
    therapist_id with =,
    tstzrange(depart_at, free_at, '[)') with &&
  ) where (status in ('held', 'confirmed', 'enroute', 'in_service', 'done'));

create index if not exists reservations_therapist_time_idx
  on reservations (therapist_id, depart_at);
create index if not exists reservations_customer_idx on reservations (customer_id);
create index if not exists reservations_status_idx on reservations (status);
create index if not exists reservations_start_at_idx on reservations (start_at);

drop trigger if exists reservations_set_updated_at on reservations;
create trigger reservations_set_updated_at
  before update on reservations
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- slot_holds: 仮押さえの追跡（spec 5-5）
-- 枠の防衛線は reservations(status='held') + exclusion 制約。ここは
-- 「誰の（session_id）・いつまでの（expires_at）ホールドか」の控えで、
-- 期限切れ解放と、確定時の本人性確認（session 一致）に使う。
-- reservation_id on delete cascade: held 行の削除で追跡行も消える。
-- ---------------------------------------------------------------------------
create table if not exists slot_holds (
  id              uuid primary key default gen_random_uuid(),
  reservation_id  uuid not null unique references reservations (id) on delete cascade,
  therapist_id    uuid not null references therapists (id) on delete cascade,
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  depart_at       timestamptz not null,
  free_at         timestamptz not null,
  session_id      text not null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);

create index if not exists slot_holds_expires_idx on slot_holds (expires_at);
create index if not exists slot_holds_session_idx on slot_holds (session_id);

-- ---------------------------------------------------------------------------
-- release_expired_holds(): 期限切れホールドの解放（spec 5-5「期限切れは cron で解放」）
-- cron 配線はフェーズ20。本フェーズでは仮押さえ・確定の各 Server Action が
-- 実行前に呼ぶ（参照時の除外と二重の防御）。held 行そのものを削除する
-- （確定前の枠確保に過ぎず、台帳的な保存価値が無いため。slot_holds は cascade で消える）。
-- ---------------------------------------------------------------------------
create or replace function release_expired_holds() returns integer
language sql
as $$
  with released as (
    delete from reservations r
    using slot_holds h
    where h.reservation_id = r.id
      and r.status = 'held'
      and h.expires_at <= now()
    returning r.id
  )
  select count(*)::integer from released;
$$;

-- ---------------------------------------------------------------------------
-- reservation_options: 予約に付いたオプションのスナップショット（spec 3-4・4章）
-- 予約時点の価格・時間・バック（type + value）を控える。オプションの後変更に耐える。
-- ---------------------------------------------------------------------------
create table if not exists reservation_options (
  reservation_id      uuid not null references reservations (id) on delete cascade,
  option_id           uuid not null references options (id) on delete restrict,
  price_snapshot      integer not null
                      constraint reservation_options_price_check check (price_snapshot >= 0),
  duration_snapshot   integer not null
                      constraint reservation_options_duration_check check (duration_snapshot >= 0),
  back_type_snapshot  option_back_type not null,
  back_value_snapshot integer not null
                      constraint reservation_options_back_value_check check (back_value_snapshot >= 0),
  created_at          timestamptz not null default now(),
  primary key (reservation_id, option_id)
);

-- ---------------------------------------------------------------------------
-- funnel_events: 予約ファネル計測（付録B-2）
-- 追記専用（update/delete はポリシーも grant も与えない）。
-- session_id は匿名セッション ID（個人情報を入れない）。meta は補助情報
--（step ごとの文脈。slot 時刻・コース id 等）。
-- ---------------------------------------------------------------------------
create table if not exists funnel_events (
  id            uuid primary key default gen_random_uuid(),
  session_id    text not null,
  step          funnel_step not null,
  therapist_id  uuid references therapists (id) on delete set null,
  meta          jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now()
);

create index if not exists funnel_events_session_idx on funnel_events (session_id, occurred_at);
create index if not exists funnel_events_step_idx on funnel_events (step, occurred_at);

-- ---------------------------------------------------------------------------
-- RLS: customers（顧客情報は機微 / spec 13-3）
--   owner/admin/reception = 全操作（電話受付が作成・修正する）
--   therapist             = 自分の担当予約がある顧客のみ select
--                           （電話番号を見せない列制御は 7-3 のビューで後続フェーズ対応）
-- ---------------------------------------------------------------------------
alter table customers enable row level security;
alter table customers force row level security;

drop policy if exists customers_staff_all on customers;
create policy customers_staff_all on customers
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists customers_therapist_select on customers;
create policy customers_therapist_select on customers
  for select using (
    app_current_role() = 'therapist'
    and exists (
      select 1
      from reservations r
      join app_users u on u.id = app_current_user_id()
      where r.customer_id = customers.id
        and r.therapist_id = u.therapist_id
    )
  );

-- ---------------------------------------------------------------------------
-- RLS: addresses（顧客住所は最重要の機微情報 / spec 13-3）
--   owner/admin/reception = 全操作（閲覧のたびに audit_logs へ記録するのは呼び出し側の義務）
--   therapist             = 自分の担当予約に紐づく住所のみ select
--                           （開始180分前ゲート + 監査の精緻化はフェーズ14/16）
-- ---------------------------------------------------------------------------
alter table addresses enable row level security;
alter table addresses force row level security;

drop policy if exists addresses_staff_all on addresses;
create policy addresses_staff_all on addresses
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists addresses_therapist_select on addresses;
create policy addresses_therapist_select on addresses
  for select using (
    app_current_role() = 'therapist'
    and exists (
      select 1
      from reservations r
      join app_users u on u.id = app_current_user_id()
      where r.address_id = addresses.id
        and r.therapist_id = u.therapist_id
    )
  );

-- ---------------------------------------------------------------------------
-- RLS: reservations
--   owner/admin/reception = 全操作（電話受付・配車ボード）
--   therapist             = 自分の担当予約のみ select（ステータス更新はフェーズ14 で追加）
-- ---------------------------------------------------------------------------
alter table reservations enable row level security;
alter table reservations force row level security;

drop policy if exists reservations_staff_all on reservations;
create policy reservations_staff_all on reservations
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists reservations_therapist_select on reservations;
create policy reservations_therapist_select on reservations
  for select using (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  );

-- ---------------------------------------------------------------------------
-- RLS: slot_holds（運用の確認・手動解放は受付まで。therapist には見せない）
-- ---------------------------------------------------------------------------
alter table slot_holds enable row level security;
alter table slot_holds force row level security;

drop policy if exists slot_holds_staff_all on slot_holds;
create policy slot_holds_staff_all on slot_holds
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- ---------------------------------------------------------------------------
-- RLS: reservation_options（予約に準じる）
-- ---------------------------------------------------------------------------
alter table reservation_options enable row level security;
alter table reservation_options force row level security;

drop policy if exists reservation_options_staff_all on reservation_options;
create policy reservation_options_staff_all on reservation_options
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists reservation_options_therapist_select on reservation_options;
create policy reservation_options_therapist_select on reservation_options
  for select using (
    app_current_role() = 'therapist'
    and exists (
      select 1
      from reservations r
      join app_users u on u.id = app_current_user_id()
      where r.id = reservation_options.reservation_id
        and r.therapist_id = u.therapist_id
    )
  );

-- ---------------------------------------------------------------------------
-- RLS: funnel_events（集計は owner/admin のみ。追記専用 = update/delete は
-- ポリシーも grant も無し。insert は公開側の特権接続経路のみ = ポリシー不要）
-- ---------------------------------------------------------------------------
alter table funnel_events enable row level security;
alter table funnel_events force row level security;

drop policy if exists funnel_events_admin_select on funnel_events;
create policy funnel_events_admin_select on funnel_events
  for select using (app_current_role() in ('owner', 'admin'));

-- ---------------------------------------------------------------------------
-- app_runtime への grant（追記専用の funnel_events は select + insert のみ）
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on customers, addresses, reservations, slot_holds, reservation_options to app_runtime;
-- funnel_events は追記専用: 0001 の default privileges（全 CRUD）を明示的に剥がす
grant select, insert on funnel_events to app_runtime;
revoke update, delete on funnel_events from app_runtime;
