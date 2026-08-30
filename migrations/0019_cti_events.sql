-- 0019_cti_events: フェーズ22 CTI 受け口（着信 webhook → 顧客ポップ）の**下地のみ**
--
-- 発注者判断で「下地だけ・後回し」（複雑・回線契約は事業者判断 / spec 付録A#6・L1074・L1311）。
-- ここでは着信イベントの**受け口テーブル**だけを用意する。着信 webhook が電話番号で
-- 顧客を引き当て、この表に1行積む。受付画面（/admin/cti）が最近の着信を表示＝「ポップ」の下地。
-- CTI ベンダー固有の署名検証・リアルタイム push・回線契約前提の作り込みは先送り。

create table if not exists cti_events (
  id            bigint generated always as identity primary key,
  phone         text not null,
  customer_id   uuid references customers (id) on delete set null,
  matched_name  text,                    -- 引き当てた顧客名の控え（顧客削除に耐える）
  handled_by    uuid references app_users (id) on delete set null,
  handled_at    timestamptz,
  occurred_at   timestamptz not null default now()
);

create index if not exists cti_events_occurred_idx on cti_events (occurred_at desc);
create index if not exists cti_events_phone_idx on cti_events (phone);

alter table cti_events enable row level security;
alter table cti_events force row level security;

-- staff（owner/admin/reception）のみ。therapist は不要。
drop policy if exists cti_events_staff_read on cti_events;
create policy cti_events_staff_read on cti_events
  for select using (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists cti_events_staff_insert on cti_events;
create policy cti_events_staff_insert on cti_events
  for insert with check (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists cti_events_staff_update on cti_events;
create policy cti_events_staff_update on cti_events
  for update using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

grant select, insert on cti_events to app_runtime;
grant update (handled_by, handled_at) on cti_events to app_runtime;
revoke delete on cti_events from app_runtime;
