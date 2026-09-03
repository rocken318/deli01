-- 0028_area_transport_fee: エリア別交通費（発注者決定 2026-09-04 / spec 3-8「エリア別の固定額」）
--
-- 従来は交通費が一律（site_settings.booking_fees.transport_car）だったが、
-- エリアごとの固定額に変更する。徒歩圏（travel_in_mode='walk'）は 0、車のときに
-- そのエリアの transport_fee を使う（予約時に reservations.transport_fee にスナップショット）。
--
-- 値は**税別・1000円単位**の整数円。既定 0（＝拠点/立町相当・徒歩圏）。
-- 交通費は店がドライバーへ支払う経費で、売上・バックには入れない（0027 後の会計方針）。
alter table areas
  add column if not exists transport_fee integer not null default 0
    constraint areas_transport_fee_check check (transport_fee >= 0);

comment on column areas.transport_fee is
  'エリア別の車交通費（税別・整数円・1000円単位が既定運用）。徒歩圏は 0。予約時にスナップショット。';
