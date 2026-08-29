# deli01 — 出張リラクゼーション予約システム

派遣（出張）型の予約システム。核は「移動を挟んで次の予約が入るか」を判定する**空き枠算出エンジン**（[docs/spec.md](docs/spec.md) 5章）。

- 発注書 / 全仕様: **[docs/spec.md](docs/spec.md)**
- 開発ガイド・体制・規約: **[CLAUDE.md](CLAUDE.md)**

## 技術スタック

Next.js 15 App Router + TypeScript strict / PostgreSQL(Supabase) + PostGIS / Drizzle ORM / Supabase Auth / Tailwind CSS / date-fns-tz(`Asia/Tokyo`) / Zod / Vitest・Playwright / Vercel。

## ローカル起動

```bash
pnpm install
cp .env.example .env
pnpm db:up          # docker で Postgres+PostGIS 起動
pnpm db:migrate     # マイグレーション適用
pnpm db:seed        # シード投入
pnpm dev            # http://localhost:3000
```

## 環境変数

キー名は [.env.example](.env.example) 参照。ローカル開発とCIは `DATABASE_URL`（docker）だけで回る。Supabase・Google Maps・Anthropic・メールは発注者が用意する（完成確認まで未設定でも開発は進む）。

## デプロイ

`main` へのマージで Vercel 本番デプロイ。PR ごとにプレビュー。`main` へは PR 経由のみ（直接 push 禁止）。

---

## 判断ログ

仕様に明記が無く、自動進行の中で決めた事項と理由を時系列で残す（spec「判断に迷ったら」）。金銭・個人情報・法令に関わる判断はここに書かず、発注者に確認する。

| # | 日付 | フェーズ | 判断 | 理由 |
|---|---|---|---|---|
| 1 | 2026-08-29 | 0 | 開発DBはローカル docker(Postgres17+PostGIS) を既定にし、CIは GitHub Actions の postgres サービスコンテナで実行する | spec 権限ルール「開発は本番Supabaseを触らない」を満たしつつ、Supabase未提供でも CI 通過・統合テスト（実Postgres）まで自走するため。Supabase は preview/production DB と管理側Authに用いる |
| 2 | 2026-08-29 | 0 | 空リポジトリのブートストラップとして、統治ファイル（docs/spec.md・.claude/agents・CLAUDE.md・.gitignore・README・.env.example）で初回だけ `main` を直接作成する | 空リポジトリには PR のベースが無いため。以降の実装フェーズはすべて feat ブランチ + PR 経由に統一する |
| 3 | 2026-08-29 | 0 | パッケージマネージャは pnpm を採用 | 環境に pnpm 10 が導入済みで、モノレポ化・依存の再現性に優れるため |
| 4 | 2026-08-29 | 0 | Drizzle の運用を「型は `src/db/schema.ts` / マイグレーション適用は手書きSQL + 独自ランナー（`scripts/migrate.ts`）」に分離する。drizzle-kit は SQL 生成の補助に留め、適用の正は独自ランナー | spec 1-2「マイグレーションは SQL としてリポジトリに残す」を満たしつつ、PostGIS の `geography`・reservations の exclusion 制約（spec 4章）・RLS（spec 13-3）は Drizzle スキーマDSLで正確に表現できないため。適用済みは `schema_migrations` で冪等追跡し、advisory lock で並行適用の競合を防ぐ |
| 5 | 2026-08-29 | 0 | フェーズ0のシードは phase-0 スキーマ（用語辞書・サイト設定・フィールド定義）の初期値のみとし、spec 14章・18章の本体シード（エリア40・セラピスト25・ホテル30・顧客5,000・予約15,000）は該当テーブルが増える後続フェーズで段階投入する | フェーズ0にはまだ対象テーブルが無く投入不可能なため。空き枠エンジンの性能問題は密なデータでしか現れない（spec 14章）という警告を漏らさないよう、下記「シード段階投入の対応表」で追跡する |
| 6 | 2026-08-29 | 1 | 発注者指示により (a) 環境変数 `TZ`→`APP_TZ` にリネーム、(b) CMS内AI（spec 19章）のプロバイダを Anthropic→**OpenAI** に変更（`ANTHROPIC_API_KEY`→`OPENAI_API_KEY`）、(c) メール送信は v1 では顧客/オーナー向け自動通知（リマインド/週次レポート/キャンセル待ち通知・フェーズ20）にのみ使用 | 発注者の明示的な決定。spec 19章の本文（Anthropic 記載）は歴史的記録として残し、実装は OpenAI で行う。`APP_TZ` はアプリ層の変数名を OS 標準の `TZ`（docker/OS のタイムゾーン）と区別するため |
| 7 | 2026-08-29 | 1 | **Supabase 開発プロジェクトと Vercel を接続**。Supabase(PG17+PostGIS3.3.7, ref `zzkvjeqxqeayauoexqoi`) を preview/production DB とし、Vercel 本番 env に `DATABASE_URL`(6543 transaction pooler)/`NEXT_PUBLIC_SUPABASE_URL`/`APP_TZ` を設定。0000/0001 マイグレーション＋シードを Supabase にも適用。本番 https://deli01-zeta.vercel.app が health 200 で稼働 | 発注者が Supabase を用意し「デプロイまで捌いて」と指示。開発は引き続きローカル docker(5433)、Supabase は preview/production 用に分離。アプリ接続は serverless 向けに transaction pooler、マイグレーションは session pooler(5432)。停止条件② の Supabase/Vercel は解消済み（残: anon/service_role キーは Auth 実配線時に検証、OpenAI/Maps は該当フェーズで） |
| 8 | 2026-08-29 | 1 | 認証/権限の設計判断（architect）: (a) 枠外予約の許可ロールに reception を含める（常に理由必須）、(b) `audit_logs.id` は追記順が保たれる bigint identity、(c) 住所閲覧の可視終了側の上限は設けない | (a) spec 8-1 が電話受付を枠外予約の担い手として明記しているため。(b) 監査ログの時系列同定を確実にするため。(c) spec に終了上限の規定がなく、当日の道順再確認を妨げないため。RLS は接続ユーザーを1本にし GUC(`app.current_user_id`/`app.current_role`)＋`SET LOCAL ROLE app_runtime` で降格、未設定は fail-closed |
| 9 | 2026-08-29 | 2 | CMS 動的フォームの保存先として汎用の `entity_records`（entity+slug, draft/published jsonb）を1枚導入（spec 3-1 の therapist_profiles に倣う。EAV にしない）。RLS は owner/admin 全操作・reception は SELECT のみ・therapist 不可。認証は開発スタブ（owner）で、live Supabase 配線は後差し | spec 3-1「値は対象テーブルの jsonb カラムに入れる」に沿い、entity 横断で使い回せる保存先を1枚で用意。reception は電話受付で内容参照の可能性があり SELECT のみ許可。動的フォームは毎リクエストで `field_definitions` を読むため、項目追加が即フォームに反映される（受入条件を実証済み） |

### シード段階投入の対応表（判断ログ #5 の追跡）

spec 18章の本体シードを、対象テーブルが揃うフェーズで投入する。各フェーズの完了時にこの表を更新する。

| データ | 目標規模（spec 18章） | 投入フェーズ | 状態 |
|---|---|---|---|
| 用語辞書・サイト設定・フィールド定義 | 初期セット | 0 | ✅ 済 |
| コース / オプション / 指名・加算・交通費 | spec 18-1〜18-3 | 7 | 予定 |
| エリア40 / 移動時間マトリクス | 40エリア | 6 | 予定 |
| ホテル30 | 30施設 | 7 | 予定 |
| セラピスト25（ランク3段階・個別特例3人 / spec 18-5） | 25名 | 4 | 予定 |
| 出勤予定 | 現実的分布 | 8 | 予定 |
| 顧客5,000（4割ポイント保有） | 5,000 | 16 | 予定 |
| 予約1年分15,000（3割オプション・土日夜偏り・指名率6割・キャンセル1割） | 15,000 | 11以降 | 予定 |
| 報酬レート・ポイント初期設定 | spec 18-4・18-6 | 18 / 16 | 予定 |
| ダミー画像（ヒーロー2・コース4・セラピスト25 / placeholder タグ） | 31点 | 3〜4 | 予定 |

## 停止条件で発注者に依頼する事項（判明分）

以下は spec 停止条件②（発注者にしか用意できないもの）。未提供でも開発とCIは進むが、該当フェーズの「プレビュー/本番」到達に必要:

- **Supabase 開発プロジェクト**（URL / anon key / service role key）— 管理側 Auth、preview/production DB
- **Vercel プロジェクト**（GitHub 連携）— プレビュー URL（フェーズ0の完了条件「プレビューが出る」）
- **Google Maps Distance Matrix API キー** — 車のエリア間移動時間の初期一括生成（フェーズ6/9。未提供時は直線距離×係数の暫定値で代替）
- **Anthropic API キー** — CMS内AIアシスタント（フェーズ21）
- **メール送信プロバイダ** — リマインド・週次レポート（フェーズ20）
