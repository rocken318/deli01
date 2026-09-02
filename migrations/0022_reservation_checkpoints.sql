-- 0022_reservation_checkpoints: 受付表の進行チェックポイント（入室電話）＋清算（集金照合）
--
-- 既存で満たすもの: 確認電話=phone_confirmed_at / 入室=arrived_at・service_started_at /
--                   退出=done_at。新規は「入室電話（お客様から入室の連絡がきた）」と
--                   「清算（帰社時に回収額を総額と照合して締める）」だけ。
--
-- 会計の売上台帳(revenue_lines)・payments は別系統。ここは運用の照合記録（誰が/いつ/回収額）。
-- reservations の RLS は 0008 の owner/admin/reception=全操作をそのまま使う
-- （therapist ガードトリガは where app_current_role()='therapist' の条件付き＝管理側は自由）。

alter table reservations
  add column if not exists entry_call_at    timestamptz,               -- お客様からの入室連絡を受けた時刻
  add column if not exists collected_amount integer,                   -- 帰社時に回収した金額（円）
  add column if not exists reconciled_at    timestamptz,               -- 清算（照合）を締めた時刻
  add column if not exists reconciled_by    uuid references app_users (id) on delete set null, -- 照合した人
  add column if not exists settle_note      text,                      -- 差額メモ（差額≠0 のとき必須）
  add column if not exists is_card_payment  boolean not null default false,
  add column if not exists payment_url       text;                     -- カード決済URL（配線のみ・v1は手動/空）

-- 回収額は非負（金額は整数円）
alter table reservations
  drop constraint if exists reservations_collected_amount_check;
alter table reservations
  add constraint reservations_collected_amount_check
    check (collected_amount is null or collected_amount >= 0);
