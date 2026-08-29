-- 0010_append_only_logs: lost_orders / call_logs を追記専用に（推奨10 / spec 8-1）
--
-- 0009_order_entry.sql で SELECT/INSERT/UPDATE/DELETE を一括 grant していたが、
-- 不成立ログ・架電記録はファネルと同様に追記専用（書き換え・削除禁止）とする。
-- UPDATE/DELETE の GRANT を REVOKE し、RLS ポリシーも SELECT/INSERT 分離に変更する。

-- 1. 追記専用化: UPDATE / DELETE 権限を剥奪
revoke update, delete on lost_orders from app_runtime;
revoke update, delete on call_logs from app_runtime;

-- 2. lost_orders: SELECT/INSERT のみの分離ポリシー
--    (0009 の for all ポリシーを削除して差し替え)
drop policy if exists lost_orders_staff_all on lost_orders;

create policy lost_orders_staff_read on lost_orders
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

create policy lost_orders_staff_insert on lost_orders
  for insert
  with check (app_current_role() in ('owner', 'admin', 'reception'));

-- 3. call_logs: SELECT/INSERT のみの分離ポリシー
drop policy if exists call_logs_staff_all on call_logs;

create policy call_logs_staff_read on call_logs
  for select
  using (app_current_role() in ('owner', 'admin', 'reception'));

create policy call_logs_staff_insert on call_logs
  for insert
  with check (app_current_role() in ('owner', 'admin', 'reception'));
