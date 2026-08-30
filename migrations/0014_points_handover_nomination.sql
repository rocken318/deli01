-- 0014_points_handover_nomination: フェーズ16 ポイント台帳・引き継ぎメモ・指名NG/指名料
--
-- 設計の骨子（spec 9章）:
--   1. point_entries ★（L826-833）: 残高をカラムで持たない**追記専用台帳**。
--      残高 = sum(points)。0010 (lost_orders/call_logs) と同じく
--      「update/delete を revoke + RLS select/insert 分離」で追記専用を二重に担保。
--      このパターンはフェーズ17 (revenue_lines)・18 (payout_lines) が再利用する。
--   2. ロット追跡: 「期限は付与単位・古いものから消費（先入先出）」(L837) のため、
--      **ロット = points > 0 かつ lot_id is null の行**（earn / 正の adjust）と定義し、
--      消費・失効・逆仕訳の行が lot_id で対象ロットを指す。
--        ロット残 = ロット.points + sum(lot_id がそのロットを指す行の points)
--      負の行（use/expire/負の adjust）は必ず lot_id を持つ（check で強制）。
--      これで「どの付与がいつ消費/失効したか」が台帳だけで完全に再構成できる。
--   3. customers.cached_points: 参照高速化のキャッシュ（L836「重ければトリガで更新」）。
--      **正は台帳**。after insert トリガで += NEW.points（追記専用なので加算のみで一致）。
--   4. handover_notes（L810-814）: 施術後の引き継ぎメモ。therapist には
--      「その顧客の**次回以降の自分の担当予約**があるときだけ」見せる（顧客住所と同じ
--      発想の RLS / 0012 addresses_therapist_select 参照）。顧客本人・他セラピストには見せない。
--   5. customer_therapist_ng（L808）: 指名NG。**reservations への guard トリガ**で
--      DB 層でも予約作成を止める（アプリのチェックだけに頼らない / CLAUDE.md 設計原則）。
--   6. therapist_courses（L816-817・フェーズ7 判断ログ#16(c) の予告）: コース×セラピストの
--      対応可否と個別指名料。未設定は courses.nomination_fee_default が既定。

-- ---------------------------------------------------------------------------
-- 1. point_entries: ポイント追記専用台帳 ★
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'point_entry_type') then
    -- earn=付与(+) / use=利用(−) / expire=失効(−) / adjust=調整(±) / reverse=逆仕訳(±)
    create type point_entry_type as enum ('earn', 'use', 'expire', 'adjust', 'reverse');
  end if;
end $$;

-- 残高キャッシュ（正は台帳 / spec L836）
alter table customers
  add column if not exists cached_points integer not null default 0;

create table if not exists point_entries (
  id             bigint generated always as identity primary key,  -- 追記順
  customer_id    uuid not null references customers (id) on delete restrict,
  type           point_entry_type not null,
  points         integer not null,          -- earn:+ / use・expire:−（0 は不可）
  reservation_id uuid references reservations (id) on delete set null,
  reason         text,
  expires_at     timestamptz,               -- 付与(ロット)単位の期限（spec L837）
  lot_id         bigint references point_entries (id),  -- 消費/失効/逆仕訳の対象ロット
  occurred_at    timestamptz not null default now(),
  created_by     uuid references app_users (id) on delete set null,

  constraint point_entries_nonzero_check check (points <> 0),
  -- type と符号の整合（adjust/reverse は両符号可）
  constraint point_entries_sign_check check (
    (type = 'earn' and points > 0)
    or (type in ('use', 'expire') and points < 0)
    or (type in ('adjust', 'reverse'))
  ),
  -- 負の行は必ずロットを指す（FIFO の追跡が台帳だけで閉じる）
  constraint point_entries_lot_required_check check (points > 0 or lot_id is not null),
  -- earn はロットそのもの（他ロットを指さない）
  constraint point_entries_earn_no_lot_check check (type <> 'earn' or lot_id is null),
  -- 自己参照は禁止（earn の lot_id は null 運用。id は insert 前に未知のため）
  constraint point_entries_lot_self_check check (lot_id is null or lot_id <> id),
  -- 期限を持てるのはロット行（正・lot_id null）だけ
  constraint point_entries_expiry_scope_check check (
    expires_at is null or (points > 0 and lot_id is null)
  )
);

create index if not exists point_entries_customer_idx
  on point_entries (customer_id, occurred_at);
create index if not exists point_entries_lot_idx
  on point_entries (lot_id) where lot_id is not null;
create index if not exists point_entries_reservation_idx
  on point_entries (reservation_id) where reservation_id is not null;
-- 施術完了(done)による自動付与は1予約1回だけ（金銭・二重付与防止 / reviewer B2）。
-- ボーナス earn（reason が異なる）や手動付与とは衝突しない部分 unique。
create unique index if not exists point_entries_reservation_earn_uniq
  on point_entries (reservation_id)
  where type = 'earn' and reason = 'reservation_done';

-- 追記専用化（0010 と同じパターン）: update/delete の grant を剥奪
grant select, insert on point_entries to app_runtime;
revoke update, delete on point_entries from app_runtime;

alter table point_entries enable row level security;
alter table point_entries force row level security;

-- staff (owner/admin/reception) のみ。therapist は顧客の残高・履歴を見ない
-- （報酬に関わらない顧客の金銭情報 / spec 13-3 の最小開示）。
drop policy if exists point_entries_staff_read on point_entries;
create policy point_entries_staff_read on point_entries
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists point_entries_staff_insert on point_entries;
create policy point_entries_staff_insert on point_entries
  for insert
  with check (
    app_current_role() in ('owner', 'admin', 'reception')
    -- actor 詐称防止（0012 (h) と同じ発想）
    and (created_by is null or created_by = app_current_user_id())
  );

-- cached_points 同期トリガ: 追記専用なので after insert の加算のみで台帳と一致する
create or replace function point_entries_sync_cached_points() returns trigger
language plpgsql
as $$
begin
  update customers
     set cached_points = cached_points + new.points
   where id = new.customer_id;
  return null;
end;
$$;

drop trigger if exists point_entries_cache_sync on point_entries;
create trigger point_entries_cache_sync
  after insert on point_entries
  for each row execute function point_entries_sync_cached_points();

-- ---------------------------------------------------------------------------
-- 2. handover_notes: 施術後の引き継ぎメモ（spec L810-814）
-- ---------------------------------------------------------------------------
create table if not exists handover_notes (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references customers (id) on delete cascade,
  reservation_id uuid references reservations (id) on delete set null,
  therapist_id   uuid not null references therapists (id) on delete restrict,  -- 書いた人
  body           text not null
                 constraint handover_notes_body_check check (length(btrim(body)) > 0),
  created_at     timestamptz not null default now()
);

create index if not exists handover_notes_customer_idx
  on handover_notes (customer_id, created_at desc);

alter table handover_notes enable row level security;
alter table handover_notes force row level security;

-- staff は全操作（開示請求・不適切表現の削除対応があるため update/delete も残す）
drop policy if exists handover_notes_staff_all on handover_notes;
create policy handover_notes_staff_all on handover_notes
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- therapist select: 「その顧客の**次回以降の自分の担当予約**があるとき」だけ
-- 当該顧客のメモが読める（spec L813「担当セラピストにだけ・無関係には見せない」。
-- 0012 addresses_therapist_select と同じ「担当予約 × status」発想）。
-- status confirmed/enroute/in_service = まだ完了していない自分の担当予約。
-- done になれば消える（受入 L1123: 次回予約の担当者にだけ表示）。
-- 顧客本人はそもそも DB ロールを持たない（公開側は特権 Server Action 経由で
-- handover_notes を一切 select しない）ため見えない。
drop policy if exists handover_notes_therapist_select on handover_notes;
create policy handover_notes_therapist_select on handover_notes
  for select using (
    app_current_role() = 'therapist'
    and exists (
      select 1
      from reservations r
      join app_users u on u.id = app_current_user_id()
      where r.customer_id = handover_notes.customer_id
        and r.therapist_id = u.therapist_id
        and r.status in ('confirmed', 'enroute', 'in_service')
    )
  );

-- therapist insert: 自分名義（therapist_id = 自分）で、実際に担当した
-- （in_service/done の）その顧客の予約があるときだけ書ける（「施術完了時に残す」）。
-- reservation_id を指定する場合はその予約自体が条件を満たすこと。
drop policy if exists handover_notes_therapist_insert on handover_notes;
create policy handover_notes_therapist_insert on handover_notes
  for insert
  with check (
    app_current_role() = 'therapist'
    and therapist_id = (
      select therapist_id from app_users
      where id = app_current_user_id() and therapist_id is not null
      limit 1
    )
    and exists (
      select 1
      from reservations r
      where r.customer_id = handover_notes.customer_id
        and r.therapist_id = handover_notes.therapist_id
        and r.status in ('in_service', 'done')
        and (handover_notes.reservation_id is null or r.id = handover_notes.reservation_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 3. customer_therapist_ng: 指名NG（spec L808）
-- ---------------------------------------------------------------------------
create table if not exists customer_therapist_ng (
  customer_id  uuid not null references customers (id) on delete cascade,
  therapist_id uuid not null references therapists (id) on delete cascade,
  reason       text,
  created_by   uuid references app_users (id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (customer_id, therapist_id)
);

alter table customer_therapist_ng enable row level security;
alter table customer_therapist_ng force row level security;

-- staff のみ（セラピスト本人には「誰にNGされたか」を見せない）
drop policy if exists customer_therapist_ng_staff_all on customer_therapist_ng;
create policy customer_therapist_ng_staff_all on customer_therapist_ng
  for all
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- NG guard: 「その組み合わせは公開側でも予約できない」(L808) を DB 層で担保。
-- 公開 Web・電話受付・管理のどの経路でも、NG 組合せの予約 insert /
-- customer_id・therapist_id の付け替え update を拒否する。
-- security definer: 呼び出しロール（app_runtime + therapist 等）が
-- customer_therapist_ng を select できなくても判定が空振りしないようにする。
create or replace function reservations_ng_guard() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is not null and exists (
    select 1 from customer_therapist_ng g
    where g.customer_id = new.customer_id
      and g.therapist_id = new.therapist_id
  ) then
    raise exception 'customer_therapist_ng_blocked: この顧客とセラピストの組み合わせは指名NGです'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_ng_guard on reservations;
create trigger reservations_ng_guard
  before insert or update of customer_id, therapist_id on reservations
  for each row execute function reservations_ng_guard();

-- ---------------------------------------------------------------------------
-- 4. therapist_courses: コース対応可否と個別指名料（spec L816-817）
--    nomination_fee null = courses.nomination_fee_default を使う
-- ---------------------------------------------------------------------------
create table if not exists therapist_courses (
  therapist_id   uuid not null references therapists (id) on delete cascade,
  course_id      uuid not null references courses (id) on delete cascade,
  is_available   boolean not null default true,
  nomination_fee integer
                 constraint therapist_courses_nomination_fee_check
                 check (nomination_fee is null or nomination_fee >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (therapist_id, course_id)
);

drop trigger if exists therapist_courses_set_updated_at on therapist_courses;
create trigger therapist_courses_set_updated_at
  before update on therapist_courses
  for each row execute function set_updated_at();

alter table therapist_courses enable row level security;
alter table therapist_courses force row level security;

-- courses と同じ構成: 編集は owner/admin、reception/therapist は select のみ
-- （公開側の読み取りは特権 Server Action 経由 / 0006 と同じ整理）
drop policy if exists therapist_courses_owner_admin on therapist_courses;
create policy therapist_courses_owner_admin on therapist_courses
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists therapist_courses_staff_select on therapist_courses;
create policy therapist_courses_staff_select on therapist_courses
  for select using (app_current_role() in ('reception', 'therapist'));
