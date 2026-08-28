-- 0000_init: 拡張と CMS の背骨（フェーズ0）
-- 手書き SQL マイグレーション。PostGIS / btree_gist / exclusion / RLS はここで定義する。
-- 以降のフェーズで architect がテーブルを追加していく。

-- 拡張（spec 1-2 / 4章）
create extension if not exists postgis;      -- 住所の座標・距離計算
create extension if not exists btree_gist;   -- reservations の exclusion 制約（後続フェーズ）

-- CMS フィールド型（spec 3-1）
do $$
begin
  if not exists (select 1 from pg_type where typname = 'field_type') then
    create type field_type as enum (
      'text','textarea','rich_text','number','boolean',
      'select','multi_select','tag','image','image_gallery',
      'date','url','money'
    );
  end if;
end $$;

-- グローバル設定（spec 3-6）
create table if not exists site_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- 用語辞書（spec 13-1）。公開側は必ずここを参照。locale で多言語の下準備。
create table if not exists terminology (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,
  value       text not null,
  locale      text not null default 'ja',
  updated_at  timestamptz not null default now(),
  constraint terminology_key_locale_unique unique (key, locale)
);

-- CMS 項目定義（spec 3-1）。フィールド定義テーブル + JSONB。EAV にしない。
create table if not exists field_definitions (
  id            uuid primary key default gen_random_uuid(),
  entity        text not null,
  key           text not null,
  label         text not null,
  type          field_type not null,
  options       jsonb,
  group_label   text,
  sort_order    integer not null default 0,
  is_public     boolean not null default false,
  is_required   boolean not null default false,
  is_filterable boolean not null default false,
  help_text     text,
  deleted_at    timestamptz,             -- 論理削除（既存の値を巻き添えにしない）
  created_at    timestamptz not null default now(),
  constraint field_definitions_entity_key_unique unique (entity, key)
);
