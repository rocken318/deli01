-- 0016_payouts: フェーズ18 報酬（業務委託バック）・締め・支払明細（spec 11章 L873-949）
--
-- 設計の骨子:
--   1. therapist_ranks（spec L415・18-4）: レート既定値のためのランク。
--      既定3段階（新人/レギュラー/プレミア）を固定 UUID で冪等投入。
--      therapists.rank_id で紐付け（最小変更。中間表は不要）。
--   2. payout_rates（spec 11-1 L879-891）: レートは**適用開始日つき**。
--      優先順位 = 個別（therapist_id）> ランク別（rank_id）> 既定（両方 null）。
--      spec は value numeric だが本プロジェクトは整数厳守 → 円は整数・率は整数%。
--      レートを変えても過去は変わらない（L1094）: 根拠は
--      (a) payout_lines.calc_note に計算時点のレートをスナップショット、
--      (b) 締め済み期間への行追加を DB トリガで拒否（payout_lines_period_lock）。
--   3. payout_lines（spec 11-2 L903）: **追記専用台帳** ★。修正は reversal_of の
--      逆仕訳のみ。calc_note jsonb not null に「使ったレート・元金額・計算式・
--      レートID・適用日」を必ず残す（L913・受入 L1098）。
--      二重計上防止は 0015 と同じ部分 unique（reservation×category / option /
--      reversal）。therapist は**自分の行のみ** select（受入 L1134）。
--   4. payouts（spec 11-4 L926）: 締め。status='closed' でロック（トリガ）。
--      closed 後に許すのは closed→paid の遷移だけ。金額・期間の変更は不可。
--      期間の重複はセラピスト単位の exclusion 制約（daterange）で DB が止める。
--      インボイス登録番号（therapists.invoice_reg_no）と源泉フラグ
--      （therapists.withholding。**既定オフ** / spec L936。額の自動判定は
--      やらない = 16章。控除は payout_deductions kind='withholding' で手入力）は
--      締め時に payouts へスナップショット。
--   5. payout_lines と revenue_lines は独立して積む（spec L949）。
--      片方から他方を導出しない。突合は集計時のみ。

-- ---------------------------------------------------------------------------
-- 0. enum 定義（冪等）
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'payout_target_type') then
    create type payout_target_type as enum
      ('course', 'option', 'nomination', 'transport', 'late_night', 'cancel_fee');
  end if;
  if not exists (select 1 from pg_type where typname = 'payout_category') then
    -- payout_lines の区分。target 種別 + 手動調整（adjustment）
    create type payout_category as enum
      ('course', 'option', 'nomination', 'transport', 'late_night',
       'cancel_fee', 'adjustment');
  end if;
  if not exists (select 1 from pg_type where typname = 'payout_calc_type') then
    -- fixed = 円（整数） / rate = 率（整数%）
    create type payout_calc_type as enum ('fixed', 'rate');
  end if;
  if not exists (select 1 from pg_type where typname = 'payout_status') then
    create type payout_status as enum ('open', 'closed', 'paid');
  end if;
  if not exists (select 1 from pg_type where typname = 'payout_deduction_kind') then
    -- 立替・備品・貸付（spec L930）+ 源泉（手入力 / L936）+ その他
    create type payout_deduction_kind as enum
      ('advance', 'supplies', 'loan', 'withholding', 'other');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. therapist_ranks（spec L415・18-4）
-- ---------------------------------------------------------------------------
create table if not exists therapist_ranks (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists therapist_ranks_set_updated_at on therapist_ranks;
create trigger therapist_ranks_set_updated_at
  before update on therapist_ranks
  for each row execute function set_updated_at();

-- 既定3段階（spec 18-4）。固定 UUID で冪等（seed・テストから参照できる）
insert into therapist_ranks (id, name, sort_order) values
  ('bbbbbbbb-0000-4000-9000-000000000001', '新人',     1),
  ('bbbbbbbb-0000-4000-9000-000000000002', 'レギュラー', 2),
  ('bbbbbbbb-0000-4000-9000-000000000003', 'プレミア',   3)
on conflict (id) do nothing;

alter table therapist_ranks enable row level security;
alter table therapist_ranks force row level security;

drop policy if exists therapist_ranks_admin_all on therapist_ranks;
create policy therapist_ranks_admin_all on therapist_ranks
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists therapist_ranks_read on therapist_ranks;
create policy therapist_ranks_read on therapist_ranks
  for select
  using (app_current_role() in ('reception', 'therapist'));

grant select, insert, update, delete on therapist_ranks to app_runtime;

-- ---------------------------------------------------------------------------
-- 2. therapists への追記（最小変更）
--    rank_id         = ランク（レート既定値の解決に使う）
--    invoice_reg_no  = 適格請求書発行事業者の登録番号（null = 未登録 / spec L935）
--    withholding     = 源泉徴収フラグ。**既定オフ**（spec L936。判断は税理士）
-- ---------------------------------------------------------------------------
alter table therapists
  add column if not exists rank_id uuid references therapist_ranks (id) on delete set null,
  add column if not exists invoice_reg_no text,
  add column if not exists withholding boolean not null default false;

create index if not exists therapists_rank_idx
  on therapists (rank_id) where rank_id is not null;

-- ---------------------------------------------------------------------------
-- 3. payout_rates（spec 11-1 L879-891）
--    スコープ: 個別（therapist_id）/ ランク別（rank_id）/ 既定（両方 null）。
--    両方同時指定は不可。value は calc_type='fixed' なら円、'rate' なら整数%。
--    適用期間 [effective_from, effective_to)（effective_to null = 無期限）。
-- ---------------------------------------------------------------------------
create table if not exists payout_rates (
  id              uuid primary key default gen_random_uuid(),
  therapist_id    uuid references therapists (id) on delete cascade,
  rank_id         uuid references therapist_ranks (id) on delete cascade,
  target_type     payout_target_type not null,
  -- コースID・オプションID など。null = その種別の全対象（generic）。
  -- 具体 target_id が generic より優先（resolveRate / src/domain/payout）
  target_id       uuid,
  calc_type       payout_calc_type not null,
  value           integer not null,
  effective_from  date not null,
  effective_to    date,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references app_users (id) on delete set null,

  -- 個別とランク別は排他（既定 = 両方 null）
  constraint payout_rates_scope_check check (therapist_id is null or rank_id is null),
  -- 率は 0〜100 の整数%（小数は使わない）、固定は 0 以上の円
  constraint payout_rates_value_check check (
    (calc_type = 'rate' and value >= 0 and value <= 100)
    or (calc_type = 'fixed' and value >= 0)
  ),
  constraint payout_rates_period_check check (
    effective_to is null or effective_to > effective_from
  )
);

create index if not exists payout_rates_target_idx
  on payout_rates (target_type, effective_from);
create index if not exists payout_rates_therapist_idx
  on payout_rates (therapist_id) where therapist_id is not null;
create index if not exists payout_rates_rank_idx
  on payout_rates (rank_id) where rank_id is not null;

drop trigger if exists payout_rates_set_updated_at on payout_rates;
create trigger payout_rates_set_updated_at
  before update on payout_rates
  for each row execute function set_updated_at();

alter table payout_rates enable row level security;
alter table payout_rates force row level security;

-- レート編集は owner/admin のみ
drop policy if exists payout_rates_admin_all on payout_rates;
create policy payout_rates_admin_all on payout_rates
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists payout_rates_reception_read on payout_rates;
create policy payout_rates_reception_read on payout_rates
  for select
  using (app_current_role() = 'reception');

-- therapist は自分に適用され得るレートのみ読める（透明性 / spec L875）。
-- 他人の個別レートは見えない
drop policy if exists payout_rates_therapist_read on payout_rates;
create policy payout_rates_therapist_read on payout_rates
  for select
  using (
    app_current_role() = 'therapist'
    and (
      therapist_id is null
      or therapist_id = (
        select therapist_id from app_users
        where id = app_current_user_id() and therapist_id is not null
        limit 1
      )
    )
  );

grant select, insert, update, delete on payout_rates to app_runtime;

-- ---------------------------------------------------------------------------
-- 4. payouts（spec 11-4 L926）: 締め。closed でロック（修正は逆仕訳のみ / L921）
--    payout_lines より先に作る（period lock トリガが参照するため）
-- ---------------------------------------------------------------------------
create table if not exists payouts (
  id              uuid primary key default gen_random_uuid(),
  therapist_id    uuid not null references therapists (id) on delete restrict,
  -- 期間は日付の閉区間 [period_start, period_end]（business_date で判定）
  period_start    date not null,
  period_end      date not null,
  gross           integer not null default 0,
  deductions      integer not null default 0
                  constraint payouts_deductions_check check (deductions >= 0),
  net             integer not null default 0,
  status          payout_status not null default 'open',
  closed_at       timestamptz,
  paid_at         timestamptz,
  -- 締め時点のスナップショット（インボイス区分 / 源泉フラグ。spec L935-936）
  invoice_reg_no  text,
  withholding     boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references app_users (id) on delete set null,

  constraint payouts_period_check check (period_end >= period_start),
  -- 台帳の総和との整合: net = gross − deductions（正は payout_lines / spec L921）
  constraint payouts_net_check check (net = gross - deductions),
  constraint payouts_closed_at_check check (status = 'open' or closed_at is not null),
  constraint payouts_paid_at_check check (status <> 'paid' or paid_at is not null)
);

-- ★同一セラピストの締め期間は重複しない（exclusion 制約 / btree_gist は 0008 で導入済み）
alter table payouts drop constraint if exists payouts_no_period_overlap;
alter table payouts add constraint payouts_no_period_overlap
  exclude using gist (
    therapist_id with =,
    daterange(period_start, period_end, '[]') with &&
  );

create index if not exists payouts_therapist_idx on payouts (therapist_id, period_start);

drop trigger if exists payouts_set_updated_at on payouts;
create trigger payouts_set_updated_at
  before update on payouts
  for each row execute function set_updated_at();

-- ★締め後ロック（spec L921・受入 L1097）:
--   closed の行に許すのは closed→paid の遷移（paid_at の記録）だけ。
--   金額・期間・対象の変更、および closed/paid の削除は DB が拒否する。
create or replace function payouts_guard_locked() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'open' then
      raise exception '締め済みの支払は削除できません（修正は逆仕訳）'
        using errcode = 'P0019';
    end if;
    return old;
  end if;
  if old.status = 'paid' then
    raise exception '支払済みの行は変更できません' using errcode = 'P0019';
  end if;
  if old.status = 'closed' then
    if new.status = 'paid'
       and new.therapist_id = old.therapist_id
       and new.period_start = old.period_start
       and new.period_end   = old.period_end
       and new.gross        = old.gross
       and new.deductions   = old.deductions
       and new.net          = old.net
       and new.closed_at    = old.closed_at
       and new.invoice_reg_no is not distinct from old.invoice_reg_no
       and new.withholding  = old.withholding
       and new.paid_at is not null
    then
      return new;
    end if;
    raise exception '締め済みの支払はロックされています（修正は逆仕訳）'
      using errcode = 'P0019';
  end if;
  return new;
end $$;

drop trigger if exists payouts_lock_guard on payouts;
create trigger payouts_lock_guard
  before update or delete on payouts
  for each row execute function payouts_guard_locked();

alter table payouts enable row level security;
alter table payouts force row level security;

drop policy if exists payouts_admin_all on payouts;
create policy payouts_admin_all on payouts
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists payouts_reception_read on payouts;
create policy payouts_reception_read on payouts
  for select
  using (app_current_role() = 'reception');

-- therapist は自分の支払履歴のみ（spec 11-5）
drop policy if exists payouts_therapist_read on payouts;
create policy payouts_therapist_read on payouts
  for select
  using (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  );

grant select, insert, update, delete on payouts to app_runtime;

-- ---------------------------------------------------------------------------
-- 5. payout_lines（spec 11-2 L903）: 報酬の追記専用台帳 ★
-- ---------------------------------------------------------------------------
create table if not exists payout_lines (
  id              bigint generated always as identity primary key,  -- 追記順
  therapist_id    uuid not null references therapists (id) on delete restrict,
  -- 営業日（Asia/Tokyo の start_at の日付。逆仕訳・調整は計上日）
  business_date   date not null,
  reservation_id  uuid references reservations (id) on delete restrict,
  category        payout_category not null,
  -- option 行だけが持つ（(予約, option) 単位の二重計上防止キー）
  option_id       uuid references options (id) on delete restrict,
  -- 円・整数。報酬行は正。adjustment と逆仕訳のみ負を許す。0 行は立てない
  amount          integer not null
                  constraint payout_lines_nonzero_check check (amount <> 0),
  -- ★計算根拠のスナップショット（spec L913・受入 L1098）:
  --   使ったレート（rateId・scope・calcType・rateValue・effectiveFrom）、
  --   元金額（baseAmount）、計算式（formula）を必ず残す
  calc_note       jsonb not null,
  -- 逆仕訳: 元行を指す。逆仕訳行は符号規約の対象外
  reversal_of     bigint references payout_lines (id),
  note            text,
  created_at      timestamptz not null default now(),
  created_by      uuid references app_users (id) on delete set null,

  constraint payout_lines_sign_check check (
    reversal_of is not null or category = 'adjustment' or amount > 0
  ),
  constraint payout_lines_reversal_self_check check (
    reversal_of is null or reversal_of <> id
  ),
  constraint payout_lines_option_scope_check check (
    (category = 'option') = (option_id is not null)
  ),
  -- 予約由来の行は reservation_id 必須（浮いた報酬行を作らない）
  constraint payout_lines_reservation_required_check check (
    reservation_id is not null or category = 'adjustment'
  )
);

create index if not exists payout_lines_therapist_date_idx
  on payout_lines (therapist_id, business_date);
create index if not exists payout_lines_reservation_idx
  on payout_lines (reservation_id) where reservation_id is not null;

-- ★二重計上防止（DB 制約 / 0015 と同じ教訓）:
-- 1予約につき course/nomination/transport/late_night/cancel_fee は各1行
create unique index if not exists payout_lines_singleton_uniq
  on payout_lines (reservation_id, category)
  where category in ('course', 'nomination', 'transport', 'late_night', 'cancel_fee')
    and reversal_of is null;

-- option は (予約, option_id) につき1行
create unique index if not exists payout_lines_option_uniq
  on payout_lines (reservation_id, option_id)
  where category = 'option' and reversal_of is null;

-- 1つの元行への逆仕訳は1回だけ（二重逆仕訳の防止）
create unique index if not exists payout_lines_reversal_uniq
  on payout_lines (reversal_of)
  where reversal_of is not null;

-- ★過去不変（受入 L1094・L1097）: 締め済み（closed/paid）期間への行追加を
-- DB が拒否する。逆仕訳・調整は「当日の business_date」で open 期間に積む運用。
-- security definer: 挿入者の RLS（therapist は自分の payouts しか見えない等）に
-- よらず、必ず全 payouts に対して判定する。
create or replace function payout_lines_check_open_period() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from payouts p
    where p.therapist_id = new.therapist_id
      and p.status in ('closed', 'paid')
      and new.business_date between p.period_start and p.period_end
  ) then
    raise exception '締め済み期間（%）には計上できません。修正は逆仕訳を当日日付で行ってください',
      new.business_date using errcode = 'P0018';
  end if;
  return new;
end $$;

drop trigger if exists payout_lines_period_lock on payout_lines;
create trigger payout_lines_period_lock
  before insert on payout_lines
  for each row execute function payout_lines_check_open_period();

-- 追記専用化（0010/0014/0015 と同じパターン）
grant select, insert on payout_lines to app_runtime;
revoke update, delete on payout_lines from app_runtime;

alter table payout_lines enable row level security;
alter table payout_lines force row level security;

drop policy if exists payout_lines_staff_read on payout_lines;
create policy payout_lines_staff_read on payout_lines
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

-- ★therapist は自分の行のみ select（受入 L1134「他人の報酬を取得できない」）
drop policy if exists payout_lines_therapist_read on payout_lines;
create policy payout_lines_therapist_read on payout_lines
  for select
  using (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  );

drop policy if exists payout_lines_staff_insert on payout_lines;
create policy payout_lines_staff_insert on payout_lines
  for insert
  with check (
    app_current_role() in ('owner', 'admin', 'reception')
    and (created_by is null or created_by = app_current_user_id())
  );

-- therapist 本人による自分の行の insert（施術完了の瞬間に反映 / spec 11-5・L940。
-- 金額はサーバ側でレートから計算される。RLS は「自分の行だけ」の防衛線）
drop policy if exists payout_lines_therapist_insert on payout_lines;
create policy payout_lines_therapist_insert on payout_lines
  for insert
  with check (
    app_current_role() = 'therapist'
    and created_by = app_current_user_id()
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
  );

-- ---------------------------------------------------------------------------
-- 6. payout_deductions（spec L930）: 控除（立替・備品・貸付・源泉手入力）
--    親 payout が open の間だけ書ける。closed/paid では凍結（トリガ）
-- ---------------------------------------------------------------------------
create table if not exists payout_deductions (
  id          bigint generated always as identity primary key,
  payout_id   uuid not null references payouts (id) on delete cascade,
  kind        payout_deduction_kind not null,
  amount      integer not null
              constraint payout_deductions_amount_check check (amount > 0),
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid references app_users (id) on delete set null
);

create index if not exists payout_deductions_payout_idx on payout_deductions (payout_id);

create or replace function payout_deductions_check_open() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  target_payout_id uuid;
begin
  target_payout_id := case when tg_op = 'DELETE' then old.payout_id else new.payout_id end;
  if exists (
    select 1 from payouts p
    where p.id = target_payout_id and p.status <> 'open'
  ) then
    raise exception '締め済みの支払の控除は変更できません' using errcode = 'P0019';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists payout_deductions_open_guard on payout_deductions;
create trigger payout_deductions_open_guard
  before insert or update or delete on payout_deductions
  for each row execute function payout_deductions_check_open();

alter table payout_deductions enable row level security;
alter table payout_deductions force row level security;

drop policy if exists payout_deductions_admin_all on payout_deductions;
create policy payout_deductions_admin_all on payout_deductions
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists payout_deductions_reception_read on payout_deductions;
create policy payout_deductions_reception_read on payout_deductions
  for select
  using (app_current_role() = 'reception');

-- therapist は自分の支払の控除内訳のみ（明細の透明性 / spec 11-5）
drop policy if exists payout_deductions_therapist_read on payout_deductions;
create policy payout_deductions_therapist_read on payout_deductions
  for select
  using (
    app_current_role() = 'therapist'
    and exists (
      select 1 from payouts p
      where p.id = payout_id
        and p.therapist_id = (
          select therapist_id from app_users
          where id = app_current_user_id() and therapist_id is not null
          limit 1
        )
    )
  );

grant select, insert, update, delete on payout_deductions to app_runtime;

-- ---------------------------------------------------------------------------
-- 7. payout_policy 拡張: 値引時のバック基礎（spec L920。事業判断・既定は「値引前」）
--    0015 の include_point_use_in_base / include_ticket_redeem_in_base に追加
-- ---------------------------------------------------------------------------
update site_settings
set value = value || '{"discount_base": "before"}'::jsonb
where key = 'payout_policy'
  and not value ? 'discount_base';
