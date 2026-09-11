-- 0038_reservation_manual_sort: 予約一覧の手動表示順（設計 フェーズ11）。
-- 時刻(start_at)は不変。表示順だけを人が D&D で決められる。null は末尾扱い（アプリ層）。
alter table reservations
  add column if not exists manual_sort_order integer;
create index if not exists reservations_manual_sort_idx
  on reservations (manual_sort_order) where manual_sort_order is not null;
