-- 0002_cms_records: 汎用 entity_records テーブル（フェーズ2 / spec 3-1・14章）
--
-- 方式: フィールド定義テーブル + JSONB（EAV にしない）。
-- 値は entity_records の draft / published カラムに入れる。
-- フィールド定義 (field_definitions) と組み合わせて動的フォームを実現する。
--
-- ポリシー方針（docs/auth-rls.md §4 必須セット）:
--   owner/admin  : 全操作（select/insert/update/delete）
--   reception    : select のみ（電話受付で閲覧する可能性）
--   therapist    : アクセス不可（自分のプロフィールは therapist_profiles フェーズ4で別途）
-- ---------------------------------------------------------------------------

create table if not exists entity_records (
  id            uuid primary key default gen_random_uuid(),
  entity        text not null,
  slug          text not null,
  draft         jsonb not null default '{}',
  published     jsonb,
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint entity_records_entity_slug_unique unique (entity, slug)
);

-- entity で絞り込む（フィールド定義一覧・動的フォーム）
create index if not exists entity_records_entity_idx
  on entity_records (entity);

-- updated_at 自動更新（set_updated_at() は 0001_auth.sql で定義済み）
drop trigger if exists entity_records_set_updated_at on entity_records;
create trigger entity_records_set_updated_at
  before update on entity_records
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: enable + force + ポリシー（docs/auth-rls.md §4 必須セット）
-- ---------------------------------------------------------------------------
alter table entity_records enable row level security;
alter table entity_records force row level security;

-- owner/admin: 全操作
drop policy if exists entity_records_owner_admin on entity_records;
create policy entity_records_owner_admin on entity_records
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- reception: select のみ
drop policy if exists entity_records_reception_select on entity_records;
create policy entity_records_reception_select on entity_records
  for select
  using (app_current_role() = 'reception');

-- therapist: アクセス不可（ポリシーを張らない = デフォルト拒否）

-- ---------------------------------------------------------------------------
-- app_runtime への grant（docs/auth-rls.md §4 必須セット）
-- update/delete を含む（audit/台帳系ではないため）
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on entity_records to app_runtime;
