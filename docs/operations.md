# 運用手順（バックアップ・復旧）— operations.md

deli01 の運用者向け。バックアップの取り方・復旧手順・復旧の実演記録。**完了条件「復旧を1回試した記録がある」対応（spec 14章 フェーズ23 / L1167）。**

## 構成の前提

- 本番 DB: **Supabase**（PostgreSQL 17 + PostGIS 3.5、東京 `ap-northeast-1`、project ref `zzkvjeqxqeayauoexqoi`）。
- アプリ: **Vercel**（`main` push で本番自動デプロイ）。DB 接続は `DATABASE_URL`（6543 transaction pooler）。
- 開発 DB: ローカル docker（`deli01-db`、ポート 5433）。
- **正のスキーマ**は `migrations/*.sql`（手書き SQL・`schema_migrations` で冪等追跡）。**シード**は `scripts/seed.ts`。
- Supabase は Point-in-Time Recovery（PITR）と日次自動バックアップを提供（プランに依存）。**それとは別に、下記の論理バックアップ（pg_dump）を推奨**（プロジェクト削除・誤 DROP・移設への保険）。

## バックアップ

### A. 論理バックアップ（pg_dump・推奨）

**本番 Supabase**（session pooler 5432 or Direct 接続）:

```bash
# custom format（-Fc）で圧縮ダンプ。<DBパスワード>は発注者管理（メモリに保存しない）
pg_dump "postgresql://postgres.zzkvjeqxqeayauoexqoi:<DBパスワード>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres" \
  -Fc -f deli01_$(date +%Y%m%d).dump
```

**ローカル docker**:

```bash
docker exec deli01-db sh -c 'pg_dump -U postgres -d deli01 -Fc -f /tmp/deli01_backup.dump'
docker cp deli01-db:/tmp/deli01_backup.dump ./deli01_$(date +%Y%m%d).dump
```

- **保管**: ダンプは暗号化して社外ストレージ（別リージョン）に置く。個人情報を含むので取り扱い注意。
- **頻度の目安**: 本番稼働後は日次（cron / GitHub Actions で自動化。キーは Secrets）。少なくとも各リリース前に1回。

### B. Supabase の自動バックアップ / PITR

- ダッシュボード → Database → Backups で日次バックアップと PITR を確認・有効化。
- PITR があれば「誤操作の N 分前」に戻せる。論理バックアップと併用する。

## 復旧

### スキーマ + データを新しい DB に復元（pg_restore）

```bash
# 1. 空の復元先 DB を作る
psql "<接続文字列 / dbname=postgres>" -c "create database deli01_restore;"

# 2. ダンプを流し込む（custom format は pg_restore）
pg_restore -d "<接続文字列 / dbname=deli01_restore>" deli01_YYYYMMDD.dump

# 3. 検証（件数・PostGIS・主要テーブル）
psql "<...deli01_restore>" -tA -c "select count(*) from reservations; select postgis_version();"
```

### スキーマだけを作り直す（マイグレーションから）

DB を作り直して最新スキーマ＋シードにする（開発・新環境の初期化）:

```bash
DATABASE_URL="<接続文字列>" pnpm db:migrate   # migrations/*.sql を冪等適用
DATABASE_URL="<接続文字列>" pnpm db:seed      # 段階投入シード
```

ローカルは `pnpm db:reset`（drop→migrate→seed）で一括。

### アプリ側の復旧

- DB が復旧したら **Vercel の再デプロイは基本不要**（実行時に接続）。ただし `DATABASE_URL` を新しい接続に変えた場合は Vercel env を更新して再デプロイ（`vercel env rm/add` → `vercel redeploy`）。
- 稼働確認: `GET /api/health` が `{"ok":true,"db":"up","postgis":"3.x"}` を返せば復旧完了。

## 復旧の実演記録（★完了条件）

| 日付 | 対象 | バックアップ | 復旧 | 検証 | 結果 |
|---|---|---|---|---|---|
| 2026-08-31 | ローカル docker（deli01・全19マイグレーション適用済み） | `pg_dump -Fc` → **462ms / 288KB** | 新規 DB `deli01_restore_test` に `pg_restore` → **5,516ms（約5.5秒）** | `reservations=6`・`payout_rates=20`・`ai_actions`（10列）・`postgis=3.5` を復元先で確認。エラー0 | ✅ 成功（スキーマ・データ・PostGIS 拡張とも完全復元） |

**手順（再現可能）**: 上記「バックアップ B なし・論理ダンプ」→「復旧（pg_restore）」の通り。復元先は使い捨て DB を作り、検証後に `drop database` で破棄。

### 本番（Supabase）での実演の申し送り

上記はローカル docker での実演。**本番 Supabase での復旧リハーサルは、復元先に別 Supabase プロジェクト（or ローカル）を用意して同手順で1回行い、この表に追記すること**（本番 DB を復元先に使わない＝上書き事故防止）。所要時間はデータ量（顧客・予約の本体シード投入後）で変わるため、本体シード投入後に再計測して更新する。

## 管理者アカウントの発行（Supabase Auth / 初回・追加）

本番 `/admin`・`/mypage` は Supabase Auth（email+パスワード）でログインする。
アカウントは既存 `app_users` に auth ユーザーを紐付けて発行する（ローカルは
`ADMIN_DEV_SESSION=1` のスタブ認証のまま。本番では絶対に設定しない。仮に本番
Vercel で誤設定しても `VERCEL_ENV=production` ではスタブを拒否する二重の歯止めあり）。

0. **前提: Supabase Dashboard で Email の public signup を無効化**（Authentication →
   Providers/Sign In。招待/bootstrap 経由のみ許可）。未紐付けの auth ユーザーは
   middleware を通過し画面枠だけは見える（データは RLS で拒否）ため、第三者の
   セルフ登録を塞ぐ。

1. 発行対象を JSON で用意（`bootstrap-users.json`。**コミットしない**）:
   ```json
   [
     { "appUserId": "aaaaaaaa-0000-4000-8000-000000000001", "email": "owner@example.com" },
     { "appUserId": "aaaaaaaa-0000-4000-8000-000000000002", "email": "admin@example.com" }
   ]
   ```
   `appUserId` は seed の各ロール ID（owner=…0001 / admin=…0002 / reception=…0003 /
   therapist あおい=…0004 / れん=…0005）。
2. 本番向けに実行（`SUPABASE_SERVICE_ROLE_KEY`・`DATABASE_URL`=5432 session pooler）:
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=... \
     pnpm tsx scripts/bootstrap-auth.ts bootstrap-users.json
   ```
3. 出力された初期パスワードを各人へ安全に配布。初回ログイン後に Supabase 側で変更。
   **スクリプトは初期パスワードを標準出力に一度だけ表示する**ため、ログ収集される
   CI/共有端末では実行せず、手元の端末でのみ実行しスクロールバックを残さないこと。
4. `https://<本番>/login` から email+パスワードでログイン → `/admin` が表示されれば完了。

冪等: 既に紐付いた `app_users` はスキップ。同 email の auth ユーザーは再利用する。
無効化は `app_users.is_active=false`（ログイン即失効）。

## 関連インシデント記録

- **2026-08-31 本番全ページ500（DB down）**: Vercel `DATABASE_URL` のパスワードがローテート後に古いままで 28P01（認証失敗）。DB 自体は Healthy。対処＝Vercel env のパスワード更新＋再デプロイ。詳細と教訓は運用メモに記録済み。**db:down でも Supabase が Healthy なら pause でなく Vercel 側の認証を疑い、まず runtime logs で errcode を見る。**
