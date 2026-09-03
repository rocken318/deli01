-- 0026_hotel_knowledge: ホテル入店ノウハウ列追加（spec 8-2 拡張）。
--
-- 設計の骨子:
--   hotels テーブルに「入店知識ベース」として4列を add column if not exists で追加する。
--   既存 RLS ポリシー（hotels_owner_admin / hotels_staff_select）は列追加のみで
--   policy の再定義不要（PostgreSQL の列レベルアクセス制御はポリシーとは別）。
--   grant も hotels テーブル単位で既に app_runtime に付与済み（0006 参照）。
--
--   card_key_required boolean  — カードキー/フロント経由が必要かどうか
--   guest_charge_note text     — ゲストチャージ・同伴利用時の注意（自由記述）
--   access_note       text     — 止められた履歴・迎えの理由・入店注意（自由記述）
--   maps_url          text     — Google Maps 経路URL

alter table hotels
  add column if not exists card_key_required boolean not null default false;

alter table hotels
  add column if not exists guest_charge_note text;

alter table hotels
  add column if not exists access_note text;

alter table hotels
  add column if not exists maps_url text;
