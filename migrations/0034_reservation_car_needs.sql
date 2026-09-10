-- 0034_reservation_car_needs: 予約の車要否（設計 4.6/5.2）。
-- 既定 true（送り＋帰り両方）。既存予約も true で backfill（従来どおり board に載る）。
-- RLS: 0008 の reservations_staff_all が新列に適用。therapist guard(0012) が自動保護。

alter table reservations
  add column if not exists needs_send_car   bool not null default true,
  add column if not exists needs_return_car bool not null default true;
