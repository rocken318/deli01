-- 0003_pages_media: 固定ページ + メディアライブラリ（フェーズ3 / spec 3-6・3-7）
--
-- RLS 必須セット（docs/auth-rls.md §4）:
--   enable row level security
--   force row level security
--   ポリシー
--   app_runtime への grant

-- ---------------------------------------------------------------------------
-- face_visibility enum（spec 3-7: 顔出し可否）
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'face_visibility') then
    create type face_visibility as enum ('face', 'eyes', 'none');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- media: メディアライブラリ（spec 3-7）
-- ---------------------------------------------------------------------------
create table if not exists media (
  id              uuid primary key default gen_random_uuid(),
  storage_path    text not null default '',
  url             text not null default '',
  mime            text not null default 'image/webp',
  width           integer,
  height          integer,
  -- alt は必須（spec 3-7）。空文字も拒否し、Zod min(1) と DB 制約で二重化する。
  alt             text not null constraint media_alt_not_blank check (alt <> ''),
  tags            text[] not null default '{}',
  consent_flag    boolean not null default false,
  consent_date    date,
  face_visibility face_visibility not null default 'none',
  is_placeholder  boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists media_set_updated_at on media;
create trigger media_set_updated_at
  before update on media
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- pages: 固定ページ（spec 3-6）
-- ---------------------------------------------------------------------------
create table if not exists pages (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null,
  locale           text not null default 'ja',
  draft_fields     jsonb not null default '{}',
  published_fields jsonb,
  draft_blocks     jsonb not null default '[]',
  published_blocks jsonb,
  published_at     timestamptz,
  seo_title        text,
  seo_description  text,
  seo_ogp_image_id uuid references media (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint pages_slug_locale_unique unique (slug, locale)
);

create index if not exists pages_slug_idx on pages (slug, locale);

drop trigger if exists pages_set_updated_at on pages;
create trigger pages_set_updated_at
  before update on pages
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- banned_words: 禁止語リスト（spec 13-2）
-- ---------------------------------------------------------------------------
create table if not exists banned_words (
  id         uuid primary key default gen_random_uuid(),
  word       text not null unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: media
-- ---------------------------------------------------------------------------
alter table media enable row level security;
alter table media force row level security;

drop policy if exists media_select on media;
create policy media_select on media
  for select using (true);

drop policy if exists media_write on media;
create policy media_write on media
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- ---------------------------------------------------------------------------
-- RLS: pages
-- ---------------------------------------------------------------------------
alter table pages enable row level security;
alter table pages force row level security;

drop policy if exists pages_owner_admin on pages;
create policy pages_owner_admin on pages
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists pages_reception_select on pages;
create policy pages_reception_select on pages
  for select using (app_current_role() = 'reception');

-- ---------------------------------------------------------------------------
-- RLS: banned_words
-- ---------------------------------------------------------------------------
alter table banned_words enable row level security;
alter table banned_words force row level security;

drop policy if exists banned_words_select on banned_words;
create policy banned_words_select on banned_words
  for select using (true);

drop policy if exists banned_words_write on banned_words;
create policy banned_words_write on banned_words
  for all
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- ---------------------------------------------------------------------------
-- app_runtime への grant
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on media to app_runtime;
grant select, insert, update, delete on pages to app_runtime;
grant select, insert, update, delete on banned_words to app_runtime;
