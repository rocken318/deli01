-- 0011_message_templates: フェーズ13 送信テンプレート・送信ログ（spec 8-3 ★ / スキーマ表 L427-428）
--
-- 設計の骨子:
--   message_templates = セラピストへの送信テキストのテンプレート（CMS 編集可）。
--                       kind ごとに1行（unique）: 'inquiry'=打診用 / 'confirmed'=確定用。
--                       打診用に住所・電話番号を含めない保証はテンプレ本文に依存させず、
--                       domain の buildDispatchMessage が構造的に除去する（受入 L1108）。
--                       reception は受付でテキスト生成に読むが、編集は owner/admin のみ。
--   dispatch_logs     = 送信ログ ★（spec 8-3「誰の情報を、いつ、誰に渡したか。監査ログの対象」）。
--                       追記専用（update/delete は grant もポリシーも無し）。
--                       id は audit_logs と同様 bigint identity で追記順を保つ（判断ログ #8）。
--                       body_snapshot に実際にコピーした本文を控える = テンプレの後変更に耐える。
--                       therapist には select を与えない（他人の顧客情報授受ログを見せない）。
--                       FK は on delete restrict: 授受の記録を予約・人の削除で消させない。

-- template_kind enum（打診用 / 確定用）
do $$
begin
  if not exists (select 1 from pg_type where typname = 'template_kind') then
    create type template_kind as enum ('inquiry', 'confirmed');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- message_templates: 送信テンプレート（CMS 編集可・2種類 / spec 8-3）
-- ---------------------------------------------------------------------------
create table if not exists message_templates (
  id          uuid primary key default gen_random_uuid(),
  kind        template_kind not null unique,
  name        text not null,
  body        text not null,
  locale      text not null default 'ja',
  is_active   boolean not null default true,
  updated_by  uuid references app_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists message_templates_set_updated_at on message_templates;
create trigger message_templates_set_updated_at
  before update on message_templates
  for each row execute function set_updated_at();

alter table message_templates enable row level security;
alter table message_templates force row level security;

-- select: reception も読む（受付でのテキスト生成）。therapist は不要（本文は受け取る側）
drop policy if exists message_templates_staff_read on message_templates;
create policy message_templates_staff_read on message_templates
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

-- insert/update: テンプレ編集は owner/admin のみ（reception は編集不可）
drop policy if exists message_templates_admin_insert on message_templates;
create policy message_templates_admin_insert on message_templates
  for insert
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists message_templates_admin_update on message_templates;
create policy message_templates_admin_update on message_templates
  for update
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- delete は付与しない（2種類のテンプレは常設。無効化は is_active）
-- 0001 の default privileges（全 CRUD）を明示的に剥がす
grant select, insert, update on message_templates to app_runtime;
revoke delete on message_templates from app_runtime;

-- ---------------------------------------------------------------------------
-- dispatch_logs: 送信ログ ★（追記専用・監査対象 / spec 8-3 L795）
-- ---------------------------------------------------------------------------
create table if not exists dispatch_logs (
  id              bigint generated always as identity primary key,
  reservation_id  uuid not null references reservations (id) on delete restrict,
  therapist_id    uuid not null references therapists (id) on delete restrict,
  kind            template_kind not null,
  body_snapshot   text not null,
  created_by      uuid not null references app_users (id) on delete restrict,
  created_at      timestamptz not null default now()
);

create index if not exists dispatch_logs_reservation_idx on dispatch_logs (reservation_id);
create index if not exists dispatch_logs_created_at_idx on dispatch_logs (created_at);

alter table dispatch_logs enable row level security;
alter table dispatch_logs force row level security;

-- select/insert 分離ポリシー（0010 のパターン）。therapist は不可
drop policy if exists dispatch_logs_staff_read on dispatch_logs;
create policy dispatch_logs_staff_read on dispatch_logs
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists dispatch_logs_staff_insert on dispatch_logs;
create policy dispatch_logs_staff_insert on dispatch_logs
  for insert
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- 追記専用: update/delete は grant しない（default privileges を明示的に剥がす）
grant select, insert on dispatch_logs to app_runtime;
revoke update, delete on dispatch_logs from app_runtime;
