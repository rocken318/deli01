-- 0030_brands: 店舗ブランドマスタ。現状は「王様の休日（王様）」1件。
-- 将来の複数ブランド化の下地（各運用テーブルに brand_id を持たせる土台 / 設計 3章）。
-- RLS: 参照 = owner/admin/reception/therapist、書込 = owner/admin。

create table if not exists brands (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  short_name  text not null,
  sort_order  int not null default 0,
  is_active   bool not null default true,
  created_at  timestamptz not null default now()
);

-- 既定ブランド「王様の休日（王様）」を固定 UUID で冪等投入
insert into brands (id, name, short_name, sort_order) values
  ('cccccccc-0000-4000-9000-000000000001', '王様の休日', '王様', 1)
on conflict (id) do nothing;

alter table brands enable row level security;
alter table brands force row level security;

drop policy if exists brands_read on brands;
create policy brands_read on brands
  for select
  using (app_current_role() in ('owner','admin','reception','therapist'));

drop policy if exists brands_write on brands;
create policy brands_write on brands
  for all
  using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

grant select, insert, update, delete on brands to app_runtime;
