-- 0037_direction_groups: 方面グループ（設計 4.5）。運転手向けの方面ラベル。
-- hotels.direction_group_id で紐付け（将来のグルーピング用・nullable）。
-- RLS: 参照 = staff、書込 = owner/admin。

create table if not exists direction_groups (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null default 'cccccccc-0000-4000-9000-000000000001'
                references brands (id) on delete restrict,
  name        text not null,
  sort_order  int not null default 0,
  is_active   bool not null default true,
  created_at  timestamptz not null default now()
);

alter table hotels
  add column if not exists direction_group_id uuid
    references direction_groups (id) on delete set null;

alter table direction_groups enable row level security;
alter table direction_groups force row level security;

drop policy if exists direction_groups_read on direction_groups;
create policy direction_groups_read on direction_groups
  for select using (app_current_role() in ('owner','admin','reception','therapist'));
drop policy if exists direction_groups_write on direction_groups;
create policy direction_groups_write on direction_groups
  for all using (app_current_role() in ('owner','admin'))
  with check (app_current_role() in ('owner','admin'));

grant select, insert, update, delete on direction_groups to app_runtime;
