-- 0024_dispatch_fields: 配車ボード用フィールド追加（フェーズ14 改修 / spec 7-1）
--
-- reservations にドライバー（送り車）とメモを追加する。
-- 配車ボードの「1行=1配車の表」で担当者がインライン編集する列。
-- - dispatch_driver: 送りドライバー/車の記入（任意・例「田中 ハイエース」）
-- - dispatch_memo  : 配車メモ（任意・例「正面玄関で待機」）
--
-- RLS: 0008 の reservations_staff_all（owner/admin/reception 全操作）がそのまま
-- 新列にも適用される。therapist 側は reservations_therapist_select（select のみ）
-- + 0012 の reservations_therapist_guard トリガ（dispatch_* 列の変更は禁止カラムに含まれる）。
-- → 新たな policy/trigger 変更は不要。grant も 0008 の app_runtime 設定で足りる。

alter table reservations
  add column if not exists dispatch_driver text,
  add column if not exists dispatch_memo   text;
