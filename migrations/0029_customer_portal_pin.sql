-- 0029_customer_portal_pin: 会員ページ（顧客ポータル）の暗証番号ログイン（発注者決定 2026-09-06）
--
-- 顧客が「電話番号 + 暗証番号」で自分のポータル（/c/<token>）にログインできるようにする。
-- PIN は scrypt ハッシュ（salt:hash の hex）で保存。平文は持たない。スタッフが発行/変更する。
-- 認証成功時に既存 portal_token へ通す（ポータル本体は 0027 のまま）。
alter table customers
  add column if not exists portal_pin_hash text,
  -- 総当り対策: 連続失敗で一時ロック
  add column if not exists portal_login_fail_count integer not null default 0,
  add column if not exists portal_login_locked_until timestamptz;

comment on column customers.portal_pin_hash is
  '会員ページの暗証番号ハッシュ（scrypt "salt:hash" hex）。null=未設定（ログイン不可）。';

-- 電話番号での引き当てを速くする（ログインは phone で検索するため）。
create index if not exists customers_phone_idx on customers (phone);
