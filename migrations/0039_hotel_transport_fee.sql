-- 0039_hotel_transport_fee: ホテル個別の交通費（受付表「受付テーブル」Z列=ホテル名 / AA列=金額 が実データ）。
--
-- 従来はエリア別（areas.transport_fee / 0028）だけだったが、実運用は**ホテルごとに固定額**。
-- 優先順位: hotels.transport_fee（非 null）> areas.transport_fee（従来のフォールバック）。
-- 徒歩圏（立町周辺）は 0 が入る。null = 未設定 → エリア既定にフォールバック。
-- 値は整数円（税別・1000円単位の運用）。予約時に reservations.transport_fee へスナップショット。

alter table hotels
  add column if not exists transport_fee integer
    constraint hotels_transport_fee_check check (transport_fee is null or transport_fee >= 0);

comment on column hotels.transport_fee is
  'ホテル個別の車交通費（整数円）。null = 未設定でエリア既定(areas.transport_fee)にフォールバック。';
