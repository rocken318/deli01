-- 0040_therapist_ng_note: キャスト本人のNG条件メモ（案内表シートの「NG条件」相当）。
-- 例「自宅送迎NG」「深夜NG」「○○ホテルNG」「同乗NG」。受付・案内表・配車で常時表示する。
-- 予約ロジック・金額には影響しない（人が読む注意書き）。
-- RLS: 0004 の既存ポリシー（owner/admin 書込・staff 参照）が新列に適用される。

alter table therapists
  add column if not exists ng_note text;

comment on column therapists.ng_note is
  'キャスト本人のNG条件メモ（自宅送迎NG・深夜NG・特定ホテルNG 等）。表示専用。';
