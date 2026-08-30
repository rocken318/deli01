-- 0015_revenue_tickets_expenses: フェーズ17 売上台帳・支払内訳・回数券・経費
--
-- 設計の骨子（spec 10章 L853-869・9章 L844-849・11-6 L946-949）:
--   1. revenue_lines ★（L856・L858）: 売上の**追記専用台帳**。コース・オプション・
--      指名料・交通費・深夜加算をそれぞれ独立行で計上し、合算しない。
--      集計は revenue_lines だけを読む（予約テーブルを直接集計しない）。
--      修正は上書きせず reversal_of で元行を指す逆仕訳行の追記。
--      0010/0014 と同じ「update/delete revoke + RLS select/insert 分離」。
--   2. 二重計上防止は DB 制約で担保（フェーズ16 reviewer B2 の教訓）:
--        - core_uniq: 1予約につき course/ticket_redeem 行は合計1行まで。
--          「回数券消化の予約に course 行と ticket_redeem 行が両方立つ」
--          二重計上（売上の水増し）を DB が物理的に止める。
--        - singleton_uniq: nomination/transport/midnight/point_use は1予約1行。
--        - option_uniq: option 行は (予約, option_id) で1行。
--   3. ポイント会計連動（spec L844-849。フェーズ16 で先送りした分の結線）:
--        - 利用 → マイナスの revenue_line（line_type='point_use'。L847 の
--          「discount として」の実装。'discount' は直前割等の値引に予約し分離）
--        - 付与 → 売上を減らさない。引当は point_entries の残（負債）として
--          別集計（pointLiability）。revenue_line は立てない（L846）
--        - 失効 → expire 行が残を減らす = 引当の戻入（L849）。revenue には入れない
--        - バック計算基礎への算入設定（L848 既定「含める」）は
--          site_settings.payout_policy に持ち、フェーズ18 が読む
--   4. ticket_entries（L857）: 回数券の**追記専用台帳**。残回数はカラムで持たず
--      sum(count)。**前受金**: purchase 行の amount(+) が前受金の増、redeem 行の
--      amount(−) が売上への振替（端数配分 / 受入 L1092: 10,000円3回券 →
--      3,333/3,333/3,334）。前受金残高 = sum(amount)。取り消しは逆仕訳の追加。
--      ロット追跡は point_entries と同じ思想（lot = purchase 行、消費が lot_id で指す）。
--   5. payments（L855）: 支払方法の内訳。1予約で併用可（現金＋回数券など）なので
--      1予約に複数行。追記専用（修正は負額の追記）。
--   6. expenses（L868）: 経費。突合（売上−バック−経費 / 11-6）の「経費」の出所。
--      台帳ではなく入力データなので staff の update/delete を許す。

-- ---------------------------------------------------------------------------
-- 0. enum 定義（冪等）
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'revenue_line_type') then
    -- 売上行: course/option/nomination/transport/midnight/ticket_redeem は正、
    -- 値引行: discount（直前割等）/ point_use（ポイント利用）は負
    create type revenue_line_type as enum (
      'course', 'option', 'nomination', 'transport', 'midnight',
      'discount', 'point_use', 'ticket_redeem'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_method') then
    create type payment_method as enum ('cash', 'card', 'emoney', 'ticket', 'point');
  end if;
  if not exists (select 1 from pg_type where typname = 'ticket_entry_type') then
    -- purchase=発行(+) / redeem=消化(−) / expire=失効(−) / reverse=逆仕訳(±) / adjust=調整(±)
    create type ticket_entry_type as enum ('purchase', 'redeem', 'expire', 'reverse', 'adjust');
  end if;
  if not exists (select 1 from pg_type where typname = 'expense_category') then
    create type expense_category as enum ('oil', 'supplies', 'parking', 'ads', 'other');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. revenue_lines: 売上追記専用台帳 ★（spec L856・L858）
-- ---------------------------------------------------------------------------
create table if not exists revenue_lines (
  id             bigint generated always as identity primary key,  -- 追記順
  reservation_id uuid references reservations (id) on delete restrict,
  line_type      revenue_line_type not null,
  -- 円・整数。売上行は正、値引/ポイント利用は負。0 行は立てない
  amount         integer not null
                 constraint revenue_lines_nonzero_check check (amount <> 0),
  -- 集計軸（期間 × エリア × セラピスト / spec L860）。予約から計上時に写す
  area_id        uuid references areas (id) on delete set null,
  therapist_id   uuid references therapists (id) on delete set null,
  -- option 行だけが持つ（(予約, option) 単位の二重計上防止キー）
  option_id      uuid references options (id) on delete restrict,
  -- 計上日基準の日時。予約由来の行は start_at（施術日基準）
  occurred_at    timestamptz not null default now(),
  -- 逆仕訳: 元行を指す。逆仕訳行は符号規約の対象外（元行の打ち消しのため）
  reversal_of    bigint references revenue_lines (id),
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_users (id) on delete set null,

  -- 符号規約（逆仕訳行を除く）: 売上系は正・値引系は負
  constraint revenue_lines_sign_check check (
    reversal_of is not null
    or (line_type in ('course', 'option', 'nomination', 'transport',
                      'midnight', 'ticket_redeem') and amount > 0)
    or (line_type in ('discount', 'point_use') and amount < 0)
  ),
  constraint revenue_lines_reversal_self_check check (
    reversal_of is null or reversal_of <> id
  ),
  -- option 行は option_id 必須、他の行は持たない
  constraint revenue_lines_option_scope_check check (
    (line_type = 'option') = (option_id is not null)
  ),
  -- 予約由来の行種は reservation_id 必須（浮いた売上行を作らない）
  constraint revenue_lines_reservation_required_check check (
    reservation_id is not null
    or line_type in ('discount')  -- 予約に紐づかない値引調整のみ許す
  )
);

create index if not exists revenue_lines_occurred_idx on revenue_lines (occurred_at);
create index if not exists revenue_lines_reservation_idx
  on revenue_lines (reservation_id) where reservation_id is not null;
create index if not exists revenue_lines_area_therapist_idx
  on revenue_lines (area_id, therapist_id, occurred_at);

-- ★二重計上防止（DB 制約 / reviewer B2 の教訓）
-- 1予約の「施術本体の売上」は course か ticket_redeem のどちらか1行だけ。
-- 現金払い（course 行）と回数券消化（ticket_redeem 行 = 前受金の振替）が
-- 同居して売上が水増しされることを DB が止める。
create unique index if not exists revenue_lines_core_uniq
  on revenue_lines (reservation_id)
  where line_type in ('course', 'ticket_redeem') and reversal_of is null;

-- 指名料・交通費・深夜加算・ポイント利用は1予約につき1行まで
create unique index if not exists revenue_lines_singleton_uniq
  on revenue_lines (reservation_id, line_type)
  where line_type in ('nomination', 'transport', 'midnight', 'point_use')
    and reversal_of is null;

-- オプションは (予約, option_id) につき1行まで
create unique index if not exists revenue_lines_option_uniq
  on revenue_lines (reservation_id, option_id)
  where line_type = 'option' and reversal_of is null;

-- 1つの元行に対する逆仕訳は1回だけ（二重逆仕訳の防止 / reviewer S4。
-- 「DB 制約が最終防衛線」の方針を revenue_lines の逆仕訳にも徹底する）
create unique index if not exists revenue_lines_reversal_uniq
  on revenue_lines (reversal_of)
  where reversal_of is not null;

-- 追記専用化（0010/0014 と同じパターン）
grant select, insert on revenue_lines to app_runtime;
revoke update, delete on revenue_lines from app_runtime;

alter table revenue_lines enable row level security;
alter table revenue_lines force row level security;

-- staff (owner/admin/reception) のみ。therapist は売上台帳を見ない
--（自分の報酬明細はフェーズ18 の payout_lines 経由で見る / spec 11-5・13-3）
drop policy if exists revenue_lines_staff_read on revenue_lines;
create policy revenue_lines_staff_read on revenue_lines
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists revenue_lines_staff_insert on revenue_lines;
create policy revenue_lines_staff_insert on revenue_lines
  for insert
  with check (
    app_current_role() in ('owner', 'admin', 'reception')
    and (created_by is null or created_by = app_current_user_id())
  );

-- ---------------------------------------------------------------------------
-- 2. payments: 支払方法の内訳（spec L855。1予約で併用可）
-- ---------------------------------------------------------------------------
create table if not exists payments (
  id             bigint generated always as identity primary key,
  reservation_id uuid not null references reservations (id) on delete restrict,
  method         payment_method not null,
  -- 円・整数。修正は負額の追記（追記専用のため update しない）
  amount         integer not null
                 constraint payments_nonzero_check check (amount <> 0),
  occurred_at    timestamptz not null default now(),
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_users (id) on delete set null
);

create index if not exists payments_reservation_idx on payments (reservation_id);
create index if not exists payments_occurred_idx on payments (occurred_at);

grant select, insert on payments to app_runtime;
revoke update, delete on payments from app_runtime;

alter table payments enable row level security;
alter table payments force row level security;

drop policy if exists payments_staff_read on payments;
create policy payments_staff_read on payments
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists payments_staff_insert on payments;
create policy payments_staff_insert on payments
  for insert
  with check (
    app_current_role() in ('owner', 'admin', 'reception')
    and (created_by is null or created_by = app_current_user_id())
  );

-- ---------------------------------------------------------------------------
-- 3. ticket_entries: 回数券追記専用台帳 ★（spec L857）
--    残回数 = sum(count) / 前受金残高（円） = sum(amount)
--    ロット = purchase 行（count>0・lot_id null）。redeem/expire は lot_id 必須。
--    端数配分（受入 L1092）は amount 列で表す: 10,000円3回券の redeem は
--    −3,333 / −3,333 / −3,334（配分は src/domain/accounting の純関数が決める）。
-- ---------------------------------------------------------------------------
create table if not exists ticket_entries (
  id             bigint generated always as identity primary key,
  customer_id    uuid not null references customers (id) on delete restrict,
  type           ticket_entry_type not null,
  -- 回数の増減。purchase:+N / redeem:−1（1施術1回） / expire:−残回数
  count          integer not null
                 constraint ticket_entries_count_nonzero_check check (count <> 0),
  -- 前受金の増減（円・整数）。purchase:+券面総額 / redeem:−配分額 / expire:−残額
  amount         integer not null,
  -- 名目単価（表示用・任意。purchase 時のみ）。正は amount（端数配分のため
  -- 「1回いくら」は一意に定まらない。10,000円3回券の単価は 3,333.33...）
  unit_price     integer
                 constraint ticket_entries_unit_price_check
                 check (unit_price is null or unit_price >= 0),
  reservation_id uuid references reservations (id) on delete set null,
  reason         text,
  -- 失効期限（purchase ロット単位）
  expires_at     timestamptz,
  -- 消化/失効/逆仕訳の対象ロット（ticket_entries.id = purchase 行）
  lot_id         bigint references ticket_entries (id),
  occurred_at    timestamptz not null default now(),
  created_by     uuid references app_users (id) on delete set null,

  -- type と符号の整合（reverse/adjust は両符号可）
  constraint ticket_entries_sign_check check (
    (type = 'purchase' and count > 0 and amount >= 0)
    or (type in ('redeem', 'expire') and count < 0 and amount <= 0)
    or (type in ('reverse', 'adjust'))
  ),
  -- 負の行は必ずロットを指す（どの券を消化/失効したか台帳だけで再構成できる）
  constraint ticket_entries_lot_required_check check (count > 0 or lot_id is not null),
  constraint ticket_entries_purchase_no_lot_check check (type <> 'purchase' or lot_id is null),
  constraint ticket_entries_lot_self_check check (lot_id is null or lot_id <> id),
  -- 期限を持てるのはロット行（purchase）だけ
  constraint ticket_entries_expiry_scope_check check (
    expires_at is null or (count > 0 and lot_id is null)
  ),
  -- redeem は施術1回分ずつ（配分額の対応を1:1に保つ）
  constraint ticket_entries_redeem_single_check check (type <> 'redeem' or count = -1)
);

create index if not exists ticket_entries_customer_idx
  on ticket_entries (customer_id, occurred_at);
create index if not exists ticket_entries_lot_idx
  on ticket_entries (lot_id) where lot_id is not null;
create index if not exists ticket_entries_reservation_idx
  on ticket_entries (reservation_id) where reservation_id is not null;

-- ★二重消化防止（DB 制約）: 同一予約への redeem は1回だけ
create unique index if not exists ticket_entries_redeem_reservation_uniq
  on ticket_entries (reservation_id)
  where type = 'redeem';

-- ★二重逆仕訳防止（DB 制約）: 同一予約の redeem に対する reverse も1回だけ
--（redeem が1予約1回なので、その打ち消しも1回で閉じる）
create unique index if not exists ticket_entries_reverse_reservation_uniq
  on ticket_entries (reservation_id)
  where type = 'reverse';

grant select, insert on ticket_entries to app_runtime;
revoke update, delete on ticket_entries from app_runtime;

alter table ticket_entries enable row level security;
alter table ticket_entries force row level security;

drop policy if exists ticket_entries_staff_read on ticket_entries;
create policy ticket_entries_staff_read on ticket_entries
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists ticket_entries_staff_insert on ticket_entries;
create policy ticket_entries_staff_insert on ticket_entries
  for insert
  with check (
    app_current_role() in ('owner', 'admin', 'reception')
    and (created_by is null or created_by = app_current_user_id())
  );

-- ---------------------------------------------------------------------------
-- 4. expenses: 経費（spec L868。突合 11-6 の「経費」の出所）
--    入力データであり台帳ではないため staff の update/delete を許す
-- ---------------------------------------------------------------------------
create table if not exists expenses (
  id         uuid primary key default gen_random_uuid(),
  category   expense_category not null,
  amount     integer not null
             constraint expenses_amount_check check (amount > 0),
  spent_on   date not null,
  area_id    uuid references areas (id) on delete set null,
  note       text,
  created_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expenses_spent_on_idx on expenses (spent_on);
create index if not exists expenses_area_idx on expenses (area_id) where area_id is not null;

drop trigger if exists expenses_set_updated_at on expenses;
create trigger expenses_set_updated_at
  before update on expenses
  for each row execute function set_updated_at();

grant select, insert, update, delete on expenses to app_runtime;

alter table expenses enable row level security;
alter table expenses force row level security;

drop policy if exists expenses_staff_all on expenses;
create policy expenses_staff_all on expenses
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- ---------------------------------------------------------------------------
-- 5. payout_policy: バック計算基礎の設定フラグ（spec L848・L917。既定「含める」）
--    フェーズ18（報酬計算）がこれを読む。値の変更は CMS（site_settings）経由。
-- ---------------------------------------------------------------------------
insert into site_settings (key, value)
values (
  'payout_policy',
  '{"include_point_use_in_base": true, "include_ticket_redeem_in_base": true}'::jsonb
)
on conflict (key) do nothing;
