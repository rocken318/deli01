# cron（スケジュール実行）配線 — フェーズ20 ②

通知・失効・直前割・週次レポートの定期実行を Vercel Cron で自動化する。

## 構成

- **エンドポイント**: `GET /api/cron`（`src/app/api/cron/route.ts`）
- **中核**: `runCronTick(now)`（`src/lib/cron/tick.ts`）。1回の tick で以下を best-effort に順次実行する（1つ落ちても他は動く・すべて冪等）:
  1. `releaseExpiredHolds` — 期限切れ仮押さえの解放（DB 関数 `release_expired_holds()`）
  2. `reminders` — 前日／2時間前リマインドの生成＋due 分の送信（`enqueueDueReminders`・`unique(dedupe_key)` で二重防止）
  3. `expirePoints` — 期限切れポイントの失効（`expirePointsCore`・追記専用台帳）
  4. `flashDeals` — 本日 confirmed 予約への直前割一括適用（`applyFlashDealCore`・設定 `enabled=false` なら skip・対象外は core が弾く）
  5. `weeklyReport` — **月曜のみ**先週分の週次レポート生成（`generateWeeklyReport`・`dedupe_key='weekly_report:{週頭}'` で1週1通）

- **スケジュール**: `vercel.json` の `crons` に `{"path":"/api/cron","schedule":"0 * * * *"}`（毎時）。

## 認証

`CRON_SECRET` を Vercel env に設定すると、Vercel Cron は
`Authorization: Bearer <CRON_SECRET>` を付けて叩く。ルートはこのヘッダ一致のみ許可する。

- **未設定時**: 本番（`VERCEL_ENV=production`）では **401 で拒否（fail-closed）**。開発（`vercel dev`／local）でのみ手動実行を許可。
- 手動実行（本番の疎通確認）:
  ```bash
  curl -sS https://<本番>/api/cron -H "Authorization: Bearer $CRON_SECRET"
  ```
  レスポンスは各ジョブの結果 JSON（全 ok=200／一部失敗=207／認可失敗=401）。

## プラン依存（重要）

- **Vercel Hobby**: cron は本数・頻度に制限があり、実質 **日次**トリガ。この場合でも「前日リマインド・ポイント失効・直前割・週次レポート」は成立する。**2時間前リマインドは日次では取りこぼす**（次回 tick でしか拾えない）ため、必要なら Pro へ。
- **Vercel Pro**: `schedule` を 15分間隔等に上げれば 2時間前リマインドも間に合う。設計上は tick を頻繁に叩くほど良い（すべて冪等なので多重実行は安全）。

単一エンドポイントに束ねているのは、Hobby の「cron 2本・日次」制限下でも全ジョブを回せるようにするため。頻度を変えたい場合は `vercel.json` の `schedule` だけ調整する。

## 発注者ステップ（go-live）

1. Vercel Production env に `CRON_SECRET`（十分に長いランダム文字列）を設定。
2. デプロイ後、Vercel ダッシュボードの **Cron Jobs** に `/api/cron` が登録されることを確認。
3. 上記 curl で 200/207 が返り、`notifications` outbox に想定どおり行が積まれることを確認。
4. 実メール配信は SMTP 設定済み前提（`docs/operations.md`・①メール配線）。未設定なら sender はスタブ（誤送信しない）。

関連: `src/lib/notify/*`・`src/lib/points/queries.ts`・`src/lib/flashdeal/*`・`src/lib/booking/holds.ts`
