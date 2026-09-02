# G 日次会計（受付表の確認用 / SGS 形）— 設計

発注者要望: 「カレンダーから日付を選ぶ→その日の**当日売上**＋**個人ごとのバック率で自動計算**＋**経費を手入力**＝1日の会計が締まる→**週ごと・月ごとに集計**」。

## 発注者確認（金銭定義・2026-09-02）
- **締めの可逆性**: 読み取りビュー（ロックなし）。新規テーブルを作らず既存台帳の上の UX 層。
- **集計単位**: 個人別＋店舗合計（エリア別内訳は出さない）。
- **計上日**: 営業日（受注した日）。深夜（日跨ぎ）分は前の営業日に寄せる。

## 既存台帳の再利用（新規テーブルなし）
- 売上 = `revenue_lines`（`occurred_at` = 予約 `start_at`・`therapist_id` 保持・逆仕訳込み）
- バック = `payout_lines`（`reversal_of is null`・`therapist_id`・`business_date` 保持）
- 経費 = `expenses`（`spent_on`・`category` = oil/supplies/parking/ads/other・`amount`）
- 粗利 = 純関数 `settlement({revenue, payout, expenses})`（既存 `src/domain/accounting`）
- 支払方法 = `payments.method`（既存）

## 営業日の定義（本ビュー限定）
`revenue_lines.occurred_at` も `payout_lines.business_date` も **start_at の JST 暦日**で
キーされる（コード上の既存「営業日」＝暦日）。発注者は暦日ではなく「営業日（深夜は前日）」を
選択したため、本ビューでは **06:00 JST を日の境界**にする純関数 `businessDayRange` を導入する。
- 日: `[D 06:00, D+1 06:00)`（JST）。深夜 00:00–05:59 開始の予約は前営業日 D に計上。
- 週: D を含む月曜起点の週 `[月 06:00, 翌月 06:00)`。
- 月: `[1日 06:00, 翌月1日 06:00)`。
- 売上/バック/支払方法は **timestamptz 範囲**（06:00 シフト）で集計。
- 経費は日付のみ（`spent_on`）なので **暦日範囲** `[fromDate, toDate)` で集計（運営者が営業日を選んで入力）。
- ⚠ `/admin/payouts` の締めは従来どおり暦日 `business_date` 基準。本ビューは**管理の確認用レンズ**で、
  締め処理は駆動しない（発注者「ロックなし」）。境界は UI に明示し、判断ログに残す。

## 実装
- 純関数 `src/domain/accounting/business-day.ts`（+test）: `businessDayRange(dateISO, period)`。
- コアクエリ `src/lib/accounting/daily-books.ts`: `getDailyBooksCore(sql, session, range)` →
  `{ storeTotal, byTherapist[], paymentsByMethod, expensesTotal }`。RLS 下（owner/admin）。
  - 売上: `revenue_lines` を therapist 別＋全体、`occurred_at` 範囲。
  - バック: `payout_lines`（reservation 行は予約 `start_at` 範囲で・調整行は `business_date` 範囲で）。
  - 経費: `expenses` を `spent_on` 暦日範囲で合計。
  - 粗利: `settlement()`。
- Server Action `getDailyBooks(dateISO, period)`（accounting/actions.ts）。経費入力は既存
  `addExpense`/`listExpenses` を再利用。
- 画面 `/admin/daily-books`（会計の隣・ナビ「日次会計」）: 日付ナビ＋期間トグル（日/週/月）・
  店舗合計カード（売上/バック/経費/粗利）・個人別テーブル（件数/売上/バック/店取分）・
  経費入力フォーム＋一覧・支払方法内訳。空/ロード/エラーの3状態。

## 段階
- G1（本PR）: 上記の読み取りビュー＋経費入力（日/週/月トグル込み）。
- G2（follow-up）: カレンダー月表示からの日選択・経費の編集/削除・CSV 出力。
