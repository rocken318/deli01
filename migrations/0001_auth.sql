-- 0001_auth: 認証・役割・監査ログ（フェーズ1 / spec 14章 #1）
--
-- ============================================================================
-- 設計ノート: GUC × SET ROLE × RLS の仕組み
-- ============================================================================
-- 1. アプリは 1 つの接続ユーザー（ローカル docker では postgres、本番 Supabase でも
--    接続文字列のユーザー）で DB に入る。「誰の操作か」は接続ユーザーでは表現できない。
-- 2. そこでトランザクションごとに `src/lib/auth/with-user.ts` の withUser() が
--      set local app.current_user_id = <app_users.id>
--      set local app.current_role    = <owner|admin|reception|therapist>
--      set local role app_runtime
--    を張ってから業務クエリを流す。GUC はセッション情報の受け渡し、
--    SET ROLE は「特権のない DB ロールに降格して RLS を効かせる」ため。
--    （ローカルの postgres は superuser、Supabase の postgres はテーブル owner であり、
--     どちらも素のままでは RLS を素通りする。app_runtime に降格して初めて RLS が効く。）
-- 3. ポリシーは app_current_user_id() / app_current_role()（下記 helper。
--    current_setting('app.current_user_id', true) の薄いラッパ）を参照する。
--    GUC 未設定（= withUser を通っていない）なら helper は null を返し、
--    ポリシーは不成立 = デフォルト拒否。**アプリのバグで withUser を忘れても
--    「見えない」側に倒れる**（fail-closed）。
-- 4. RLS は enable + force。ただし接続ユーザー postgres は本番 Supabase でも
--    BYPASSRLS 属性を持つ（ローカルは superuser）ため、素の接続では RLS を素通りする
--    （migrate / seed / 保守クエリはこの経路）。RLS が実効になるのは withUser 内で
--    SET LOCAL ROLE app_runtime に降格した後だけ。force は app_runtime が将来
--    テーブル owner になっても素通りさせない保険であり、防御の本線は降格である。
--
-- 将来の拡張（spec 13-3 / 15章）:
--   - addresses:    select ポリシーで「担当セラピスト かつ 予約3時間前以降」を
--                   reservations との exists 結合 + now() 比較で表現する。
--                   owner/admin/reception は業務上 select 可（閲覧は audit_logs に残す）。
--   - payouts / payout_lines: therapist は自分の therapist_id の行のみ select 可。
--                   締め済み行は update/delete ポリシーを張らない（逆仕訳のみ）。
--   - reservations: therapist は自分の担当行のみ。customers はセラピストには
--                   担当予約経由の最小限のみ（電話番号等はビューで落とす）。
--   - 新テーブルを足すときは必ず「enable + force RLS + ポリシー + app_runtime への
--     grant」をセットで書くこと。RLS 漏れは tests/integration/auth-rls.test.ts の
--     「public の全テーブルで RLS が有効」テストが検出する。
-- ============================================================================

-- ロール enum（spec 体制 / 15章）
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type app_role as enum ('owner', 'admin', 'reception', 'therapist');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- app_users: アプリ内ユーザー（Supabase auth.users とは auth_user_id で紐付け。
-- live 配線（フェーズ1後半〜）までは null のままでよい）
-- ---------------------------------------------------------------------------
create table if not exists app_users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,            -- Supabase auth.users.id（未配線なら null）
  role          app_role not null,
  therapist_id  uuid,                   -- therapists はフェーズ4で作成。FK は後続で追加
  display_name  text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- therapist 以外のロールが therapist_id を持つのは設計ミス
  constraint app_users_therapist_link check (role = 'therapist' or therapist_id is null)
);

create index if not exists app_users_therapist_id_idx
  on app_users (therapist_id) where therapist_id is not null;

-- updated_at 自動更新（以降のテーブルでも使い回す共通トリガ関数）
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists app_users_set_updated_at on app_users;
create trigger app_users_set_updated_at
  before update on app_users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_logs: 追記専用の監査ログ（spec 3章・4章）
-- 住所閲覧（spec 13-3）は action='view' / entity='address' / entity_id=addresses.id、
-- CSV 出力は action='export'、枠外予約は action='override' + after.reason で表現する。
-- id は追記順が保たれる bigint identity（台帳系と同じ思想。時系列走査が主用途）。
-- ---------------------------------------------------------------------------
create table if not exists audit_logs (
  id             bigint generated always as identity primary key,
  actor_user_id  uuid references app_users (id) on delete set null,
  action         text not null,   -- 'create'|'update'|'delete'|'view'|'export'|'override'|...
  entity         text not null,   -- 'address'|'reservation'|'app_user'|'site_setting'|...
  entity_id      uuid,
  before         jsonb,
  after          jsonb,
  ip             text,
  occurred_at    timestamptz not null default now()
);

create index if not exists audit_logs_entity_idx
  on audit_logs (entity, entity_id, occurred_at desc);
create index if not exists audit_logs_actor_idx
  on audit_logs (actor_user_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- セッション GUC の helper（ポリシーから参照。未設定なら null = デフォルト拒否）
-- ---------------------------------------------------------------------------
create or replace function app_current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

create or replace function app_current_role() returns text
language sql stable as $$
  select nullif(current_setting('app.current_role', true), '')
$$;

-- ---------------------------------------------------------------------------
-- 実行用 DB ロール app_runtime（nologin）。withUser() が set local role で降格する。
-- ロールはクラスタ共有なので冪等に作る。migrate/app の接続ユーザーに membership を渡す。
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    create role app_runtime nologin;
  end if;
  -- 接続ユーザー（ローカル: postgres / 本番: 接続文字列のユーザー）が SET ROLE できるように
  execute format('grant app_runtime to %I', current_user);
end $$;

grant usage on schema public to app_runtime;

-- 既存＋新規テーブルへの DML 権限（RLS が行レベルの絞り込みを担う。
-- audit_logs には update/delete を「grant しない」ことで追記専用を二重に担保）
grant select, insert, update, delete on site_settings, terminology, field_definitions, app_users to app_runtime;
grant select, insert on audit_logs to app_runtime;

-- 将来テーブルの grant 漏れ防止（このマイグレーションを流したユーザーが作る
-- 以後のテーブルに適用。audit 系・台帳系は各マイグレーションで revoke して絞る）
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_runtime;

-- ---------------------------------------------------------------------------
-- RLS: enable + force + ポリシー
-- ---------------------------------------------------------------------------

-- CMS の背骨3テーブル: 読みは公開（公開ページが参照する）、書きは owner/admin のみ
alter table site_settings enable row level security;
alter table site_settings force row level security;
drop policy if exists site_settings_select on site_settings;
create policy site_settings_select on site_settings
  for select using (true);
drop policy if exists site_settings_write on site_settings;
create policy site_settings_write on site_settings
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

alter table terminology enable row level security;
alter table terminology force row level security;
drop policy if exists terminology_select on terminology;
create policy terminology_select on terminology
  for select using (true);
drop policy if exists terminology_write on terminology;
create policy terminology_write on terminology
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

alter table field_definitions enable row level security;
alter table field_definitions force row level security;
drop policy if exists field_definitions_select on field_definitions;
create policy field_definitions_select on field_definitions
  for select using (true);
drop policy if exists field_definitions_write on field_definitions;
create policy field_definitions_write on field_definitions
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- app_users: 運営（owner/admin/reception）は全員を見られる（配車・受付業務に必要）。
-- therapist は自分の行のみ。書き込みは owner/admin、削除は owner のみ
-- （通常は is_active=false の無効化で運用し、行削除はしない）。
alter table app_users enable row level security;
alter table app_users force row level security;
drop policy if exists app_users_select on app_users;
create policy app_users_select on app_users
  for select using (
    app_current_role() in ('owner', 'admin', 'reception')
    or id = app_current_user_id()
  );
drop policy if exists app_users_insert on app_users;
create policy app_users_insert on app_users
  for insert with check (app_current_role() in ('owner', 'admin'));
drop policy if exists app_users_update on app_users;
create policy app_users_update on app_users
  for update
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));
drop policy if exists app_users_delete on app_users;
create policy app_users_delete on app_users
  for delete using (app_current_role() = 'owner');

-- audit_logs: 追記専用。
--   insert: セッションが張られていること + actor の詐称不可（自分の id か null のみ）
--   select: owner/admin のみ（監査の閲覧は運営トップに限る）
--   update/delete: ポリシーなし + grant なし = 不可
alter table audit_logs enable row level security;
alter table audit_logs force row level security;
drop policy if exists audit_logs_insert on audit_logs;
create policy audit_logs_insert on audit_logs
  for insert with check (
    app_current_role() is not null
    and (actor_user_id is null or actor_user_id = app_current_user_id())
  );
drop policy if exists audit_logs_select on audit_logs;
create policy audit_logs_select on audit_logs
  for select using (app_current_role() in ('owner', 'admin'));
