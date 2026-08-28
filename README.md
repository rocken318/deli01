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

## 停止条件で発注者に依頼する事項（判明分）

以下は spec 停止条件②（発注者にしか用意できないもの）。未提供でも開発とCIは進むが、該当フェーズの「プレビュー/本番」到達に必要:

- **Supabase 開発プロジェクト**（URL / anon key / service role key）— 管理側 Auth、preview/production DB
- **Vercel プロジェクト**（GitHub 連携）— プレビュー URL（フェーズ0の完了条件「プレビューが出る」）
- **Google Maps Distance Matrix API キー** — 車のエリア間移動時間の初期一括生成（フェーズ6/9。未提供時は直線距離×係数の暫定値で代替）
- **Anthropic API キー** — CMS内AIアシスタント（フェーズ21）
- **メール送信プロバイダ** — リマインド・週次レポート（フェーズ20）
