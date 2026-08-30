-- 0017_notifications_flash_deals: フェーズ20 通知基盤（アウトボックス）・直前割
--
-- 設計の骨子:
--   notifications          = 送信アウトボックス。**実メール配信はスタブ**（発注者判断。
--                            送信は src/lib/notify/sender.ts に切り出し、②メールプロバイダ
--                            提供後に nodemailer 等を差す / spec 16章「buildDispatchMessage を
--                            切り出して備える」と同じ思想）。
--                            ★重複送信防止は dedupe_key の unique を DB 層の最終防衛線とする
--                            （受入 L1131「前日と2時間前に1回ずつだけ・重複送信しない」）。
--                            dedupe_key 規約: '{kind}:{参照ID}'
--                              例) 'reminder_prev_day:{reservation_id}'
--                                  'reminder_2h:{reservation_id}'
--                                  'waitlist_open:{waitlist_id}:{YYYY-MM-DD}'
--                                  'weekly_report:{週初日 YYYY-MM-DD}'
--                            status 遷移（pending→sent/failed/skipped）のため update は許すが
--                            delete は grant しない（送った/送らなかった事実を消させない）。
--   notification_templates = kind ごとの subject/body テンプレ（CMS 編集・{{変数}}）。
--                            message_templates（0011）と同型: kind unique・locale・is_active・
--                            owner/admin 編集・reception 閲覧。既定行はこのマイグレーションが
--                            投入（on conflict do nothing。文言は CMS で自由に変更）。
--   flash_deals            = 直前割の適用履歴（spec L432・L650-654）。
--                            設定は site_settings.flash_deal_config（CMS / cancellation_policy・
--                            point_policy と同じ整理）。**既定は enabled=false**:
--                            金銭（割引）に関わるため、発注者が CMS で率・時間帯・上限を
--                            確認してから有効化する（値は雛形）。
--                            割引の金銭計上は revenue_lines の line_type='discount' 負行
--                            （0015 / spec L653）。バック基礎への影響は
--                            site_settings.payout_policy.discount_base（0016・既定 'before'）に
--                            従い、フェーズ18 buildReservationPayout の既存挙動がそのまま効く。
--                            ★二重適用防止 = unique(reservation_id)。
--                            ★1日上限（受入 L1120）は applied_on の日次カウント + アプリの
--                            advisory lock で直列化（src/lib/flashdeal/queries.ts）。
--                            追記専用（update/delete は grant しない）。
--   reservations.is_flash_deal = 公開側ラベル表示用の印（spec L654）。

-- ---------------------------------------------------------------------------
-- 0. enum 定義（冪等）
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'notification_channel') then
    -- v1 は email 中心。line は将来（spec 16章: LINE 自動送信は v1 でやらない）
    create type notification_channel as enum ('email', 'line');
  end if;
  if not exists (select 1 from pg_type where typname = 'notification_kind') then
    create type notification_kind as enum
      ('reminder_prev_day', 'reminder_2h', 'waitlist_open', 'weekly_report', 'flash_deal');
  end if;
  if not exists (select 1 from pg_type where typname = 'notification_status') then
    create type notification_status as enum ('pending', 'sent', 'failed', 'skipped');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. notifications: 送信アウトボックス ★（dedupe_key unique = 重複送信の最終防衛線）
-- ---------------------------------------------------------------------------
create table if not exists notifications (
  id              bigint generated always as identity primary key,  -- 追記順
  channel         notification_channel not null default 'email',
  kind            notification_kind not null,
  -- 宛先識別（メールアドレス / 電話番号。顧客はメールを持たないため v1 は電話番号）
  recipient       text not null,
  -- 予約・顧客への参照。アウトボックスは subject/body のスナップショットを持つため
  -- 参照が消えても行は自立する（set null）
  reservation_id  uuid references reservations (id) on delete set null,
  customer_id     uuid references customers (id) on delete set null,
  subject         text not null,
  body            text not null,
  status          notification_status not null default 'pending',
  -- 送るべき時刻（リマインドなら start_at−24h / start_at−2h）
  scheduled_for   timestamptz not null,
  sent_at         timestamptz,
  -- ★重複送信防止キー（受入 L1131）。規約はファイル冒頭のコメント参照
  dedupe_key      text not null unique,
  last_error      text,
  created_at      timestamptz not null default now(),
  created_by      uuid references app_users (id) on delete set null,

  -- sent なら sent_at 必須（送った事実に時刻を残す）
  constraint notifications_sent_at_check check (status <> 'sent' or sent_at is not null)
);

create index if not exists notifications_status_scheduled_idx
  on notifications (status, scheduled_for);
create index if not exists notifications_reservation_idx
  on notifications (reservation_id) where reservation_id is not null;

alter table notifications enable row level security;
alter table notifications force row level security;

-- staff（owner/admin/reception）のみ。therapist には顧客宛通知を見せない
drop policy if exists notifications_staff_read on notifications;
create policy notifications_staff_read on notifications
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists notifications_staff_insert on notifications;
create policy notifications_staff_insert on notifications
  for insert
  with check (
    app_current_role() in ('owner', 'admin', 'reception')
    and (created_by is null or created_by = app_current_user_id())
  );

-- status 遷移（pending→sent/failed/skipped）のため update は許す
drop policy if exists notifications_staff_update on notifications;
create policy notifications_staff_update on notifications
  for update
  using (app_current_role() in ('owner', 'admin', 'reception'))
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- delete は grant しない（送信記録を消させない。0001 の default privileges を剥がす）
grant select, insert, update on notifications to app_runtime;
revoke delete on notifications from app_runtime;

-- ---------------------------------------------------------------------------
-- 2. notification_templates: 通知テンプレ（CMS 編集・{{変数}} / 0011 と同型）
-- ---------------------------------------------------------------------------
create table if not exists notification_templates (
  id          uuid primary key default gen_random_uuid(),
  kind        notification_kind not null unique,
  name        text not null,
  subject     text not null,
  body        text not null,
  locale      text not null default 'ja',
  is_active   boolean not null default true,
  updated_by  uuid references app_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists notification_templates_set_updated_at on notification_templates;
create trigger notification_templates_set_updated_at
  before update on notification_templates
  for each row execute function set_updated_at();

alter table notification_templates enable row level security;
alter table notification_templates force row level security;

-- select: reception も読む（通知生成に使う）。編集は owner/admin のみ
drop policy if exists notification_templates_staff_read on notification_templates;
create policy notification_templates_staff_read on notification_templates
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists notification_templates_admin_insert on notification_templates;
create policy notification_templates_admin_insert on notification_templates
  for insert
  with check (app_current_role() in ('owner', 'admin'));

drop policy if exists notification_templates_admin_update on notification_templates;
create policy notification_templates_admin_update on notification_templates
  for update
  using (app_current_role() in ('owner', 'admin'))
  with check (app_current_role() in ('owner', 'admin'));

-- delete は付与しない（無効化は is_active）
grant select, insert, update on notification_templates to app_runtime;
revoke delete on notification_templates from app_runtime;

-- 既定テンプレ（雛形。文言は CMS で編集する前提 / {{変数}} は interpolate が補間。
-- 未定義変数は空文字になり落ちない = dispatch の interpolate と同一実装）
insert into notification_templates (kind, name, subject, body) values
  (
    'reminder_prev_day',
    'リマインド（前日）',
    '【ご予約リマインド】明日 {{日時}} のご予約について',
    E'{{顧客名}} 様\n\n明日のご予約のご案内です。\n\n日時: {{日時}}\nコース: {{コース}}\nセラピスト: {{セラピスト}}\n\n変更・キャンセルはお電話にてお願いいたします。'
  ),
  (
    'reminder_2h',
    'リマインド（2時間前）',
    '【ご予約リマインド】本日 {{日時}} のご予約について',
    E'{{顧客名}} 様\n\nまもなくご予約のお時間です。\n\n日時: {{日時}}\nコース: {{コース}}\nセラピスト: {{セラピスト}}\n\nご準備のほどよろしくお願いいたします。'
  ),
  (
    'waitlist_open',
    'キャンセル待ち（空き案内）',
    '【空き枠のご案内】ご希望条件に空きが出ました',
    E'{{顧客名}} 様\n\nご登録いただいた条件に空きが出ました。\n\n日付: {{日付}}\nエリア: {{エリア}}\n\nご予約はお早めにお願いいたします（本案内は空き状況のお知らせであり、お席の確保ではありません）。'
  ),
  (
    'weekly_report',
    '週次レポート',
    '【週次レポート】{{週}}',
    E'{{週}} の週次レポートです。\n\n{{本文}}'
  )
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- 3. flash_deals: 直前割の適用履歴（spec L432・L650-654 / 追記専用）
-- ---------------------------------------------------------------------------
create table if not exists flash_deals (
  id              bigint generated always as identity primary key,
  reservation_id  uuid not null references reservations (id) on delete restrict,
  -- 適用時の割引率（整数% / 設定のスナップショット）
  rate_percent    integer not null
                  constraint flash_deals_rate_check
                  check (rate_percent > 0 and rate_percent <= 100),
  -- 割引額（円・整数・正で保持。金銭計上は revenue_lines の discount 負行が正）
  amount          integer not null
                  constraint flash_deals_amount_check check (amount > 0),
  -- 適用日（Asia/Tokyo の営業日）。1日の適用上限（受入 L1120）の日次カウント根拠
  applied_on      date not null,
  -- 対応する revenue_lines の discount 行（計上との1:1対応を台帳だけで追える）
  revenue_line_id bigint not null references revenue_lines (id),
  created_at      timestamptz not null default now(),
  created_by      uuid references app_users (id) on delete set null,

  -- ★二重適用防止（DB 制約が最終防衛線）
  constraint flash_deals_reservation_uniq unique (reservation_id)
);

create index if not exists flash_deals_applied_on_idx on flash_deals (applied_on);

-- 追記専用（0010/0014/0015 と同じパターン）
grant select, insert on flash_deals to app_runtime;
revoke update, delete on flash_deals from app_runtime;

alter table flash_deals enable row level security;
alter table flash_deals force row level security;

drop policy if exists flash_deals_staff_read on flash_deals;
create policy flash_deals_staff_read on flash_deals
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

drop policy if exists flash_deals_staff_insert on flash_deals;
create policy flash_deals_staff_insert on flash_deals
  for insert
  with check (
    app_current_role() in ('owner', 'admin', 'reception')
    and (created_by is null or created_by = app_current_user_id())
  );

-- ---------------------------------------------------------------------------
-- 4. reservations.is_flash_deal: 公開側ラベル表示用の印（spec L654）
-- ---------------------------------------------------------------------------
alter table reservations
  add column if not exists is_flash_deal boolean not null default false;

-- ---------------------------------------------------------------------------
-- 5. flash_deal_config: 直前割の CMS 設定（spec L652。cancellation_policy と同じ整理）
--    ★既定は enabled=false（金銭に関わるため、発注者が CMS で実値を確認してから
--    有効化する。rate_percent 等は雛形）。
--    - window_from_hour / window_to_hour: 対象時間帯（施術開始の Asia/Tokyo 時。
--      [from, to) の半開区間。24 = その日の末尾まで。日跨ぎ窓は v1 非対応）
--    - trigger_hour: 「当日この時刻（JST）を過ぎても埋まらない枠」に適用する基準
--    - daily_limit: 1日の適用上限件数（受入 L1120）
--    - course_ids: 対象コース ID の配列。空配列 = 全コース対象
-- ---------------------------------------------------------------------------
insert into site_settings (key, value)
values (
  'flash_deal_config',
  '{
    "enabled": false,
    "rate_percent": 10,
    "window_from_hour": 18,
    "window_to_hour": 24,
    "daily_limit": 3,
    "course_ids": [],
    "trigger_hour": 15
  }'::jsonb
)
on conflict (key) do nothing;
