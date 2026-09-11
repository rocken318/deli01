-- 0036_daily_payouts: 当日給料（日払い精算）の記録（設計 4.8/5.5）。追記専用。
-- 支払額 = gross − misc（雑費=floor(gross*rate/100)）。therapist×営業日で一意。
-- RLS: 参照/精算 = owner/admin/reception。

create table if not exists daily_payouts (
  id             uuid primary key default gen_random_uuid(),
  therapist_id   uuid not null references therapists (id) on delete restrict,
  business_date  date not null,
  gross          integer not null,
  misc           integer not null,
  net            integer not null,
  paid_at        timestamptz not null default now(),
  paid_by        uuid references app_users (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint daily_payouts_uniq unique (therapist_id, business_date),
  constraint daily_payouts_net_check check (net = gross - misc),
  constraint daily_payouts_nonneg_check check (gross >= 0 and misc >= 0)
);

create index if not exists daily_payouts_date_idx on daily_payouts (business_date);

alter table daily_payouts enable row level security;
alter table daily_payouts force row level security;

drop policy if exists daily_payouts_staff on daily_payouts;
create policy daily_payouts_staff on daily_payouts
  for all using (app_current_role() in ('owner','admin','reception'))
  with check (app_current_role() in ('owner','admin','reception'));

grant select, insert, update, delete on daily_payouts to app_runtime;

-- 雑費率（既定10%）を payout_policy へ（切り捨てはアプリ層 floor）
update site_settings
set value = value || '{"misc_deduction_rate": 10}'::jsonb
where key = 'payout_policy' and not value ? 'misc_deduction_rate';
