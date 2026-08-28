# CLAUDE.md — 出張リラクゼーション予約システム（deli01）

**発注書は [`docs/spec.md`](docs/spec.md)（実装指示書 v11・最終）。判断に迷ったら必ず該当章を参照する。**

このリポジトリは店舗型ではなく**派遣（出張）型**の予約システム。核は「移動を挟んで次の予約が入るか」を判定する**空き枠算出エンジン**（spec 5章）。

## 体制（サブエージェント / spec 体制表）

本体（リード）は Opus。Fable が要る仕事は `.claude/agents/` のサブエージェントに委譲する。

| エージェント | model | 担当 |
|---|---|---|
| リード（本体） | opus | フェーズ管理・統合・PR作成・仕様突合・委譲の采配 |
| architect | fable | スキーマ・exclusion制約・RLS・空き枠エンジン・台帳（0-1・9・17-18の中心） |
| reviewer | fable | 全PRレビュー。read-only |
| db-foundation | inherit | マイグレーション・シード・CI |
| public-ui | sonnet | 公開ページ一式（spec 12-1） |
| admin-ui | sonnet | CMS・電話受付・配車ボード・マイページ（spec 12-2） |
| qa | sonnet | テスト作成/実行・15章網羅・grep検査 |

**各フェーズは PR 作成前に reviewer のレビューを通す。指摘修正までがフェーズ完了条件。**

## 自動進行と停止条件

「実装 → QA → reviewer レビュー → 修正 → PR 作成 → 次フェーズ」を指示を待たず連続で進める。
止まってよいのは3つだけ:
1. 金銭・個人情報・法令に関わる判断
2. 環境変数・アカウント・API キーなど発注者にしか用意できないもの
3. CI の失敗を3回試して直せないとき

それ以外は README の「判断ログ」に理由を残して進む。フェーズ完了ごとに PR URL・プレビュー URL・判断ログ差分を1メッセージにまとめて報告する。

## 技術スタック（spec 1-2）

Next.js 15 App Router + TypeScript strict / PostgreSQL(Supabase) + PostGIS / Drizzle ORM（SQL migration をリポジトリに残す）/ Supabase Auth（管理側）/ Tailwind CSS / date-fns・date-fns-tz（全処理 `Asia/Tokyo`）/ Zod（全 Server Action の入力検証）/ Google Maps Distance Matrix API（常時は叩かない）/ Vitest（統合は実Postgres）・Playwright / Vercel。

## 禁止事項（reviewer が grep で検査）

- 金額に小数を使わない。**すべて整数（円）**
- `any` を書かない
- クライアントから直接 DB を触らない
- 日時を文字列で計算しない。DB は `timestamptz`
- **公開側テンプレートに直書きの日本語を置かない**（用語辞書/CMS 経由 / spec 3-6・13-1）
- `.env`・API キーを絶対にコミットしない（spec 1-1）。履歴に入ったら rotate まで作業停止

## コマンド

```bash
pnpm install              # 依存インストール
pnpm dev                  # 開発サーバ（http://localhost:3000）
pnpm db:up                # ローカル Postgres+PostGIS を docker で起動
pnpm db:down              # 停止
pnpm db:generate          # Drizzle マイグレーション生成
pnpm db:migrate           # マイグレーション適用
pnpm db:seed              # シード投入（spec 18章のダミー値）
pnpm typecheck            # tsc --noEmit
pnpm lint                 # ESLint
pnpm test                 # Vitest（統合は実Postgres）
pnpm test:e2e             # Playwright
```

## 開発DBの安全ルール（spec 権限）

- DB は**開発用のみ**に接続。本番 Supabase は完成確認まで作らない・触らない
- 作業はリポジトリ内で完結。リポジトリ外に触らない
- `main` へは PR 経由のみ（直接 push 禁止）。フェーズ1つ = PR 1本。まとめない
- コミットは Conventional Commits（feat/fix/chore/docs/test）

## デザイントークン（spec 12章）

**公開側（暗い画面が既定 / 12-1）**: 背景`#151A20` 面`#1E252D` 文字`#EDE9E2` 副文字`#9BA5AF` 主色`#C6A15B`(金) 補助`#5E9E86` 罫線`#2C343D` / 見出し Shippori Mincho B1・本文 Noto Sans JP・時刻金額 IBM Plex Mono。署名要素「最短HH:MMから案内可能」を大きく金色等幅で。
**管理側（視認性と密度 / 12-2）**: 背景`#F6F7F5` 面`#FFFFFF` 文字`#1C2321` 主色`#3F7A6B` 移動ブロック`#B9C2BD` 注意`#C98A2B` 警告`#B4453C` 罫線`#DFE3DE` / 角丸4pxまで・影なし罫線区切り。
各画面共通: 空状態・ローディング・エラーの3状態を実装。公開側 LCP 2.5秒以内。

## やらないこと（spec 16章 要約）

- セラピスト位置の GPS リアルタイム追跡（手動ステータス更新で運用）
- 自動配車・最適化（「誰でもいい」は候補提示まで。割当は人間）
- オンライン決済（現地決済から）／振込の実行（明細と全銀CSV出力まで）
- LINE Messaging API 自動送信（v1はテキスト生成とコピーまで。`buildDispatchMessage` を切り出して備える）
- AI による自動公開・自動デプロイ（AI出力は下書き/提案止まり。公開とマージは人間）
- 稼働中システムの自己コード書き換え（改修はリポジトリ経由 / spec 19-3）
- CTI 回線契約・源泉徴収額の自動判定・業務委託者への時間管理/制裁機能

## フェーズ表（spec 14章）

0 基盤/CI/DB/シード → 1 認証/役割/監査 → 2 CMSフィールド定義 → 3 メディア/サイト設定/固定ページ → 4 セラピスト管理/公開 → 5 公開ページ → 6 エリア/移動計算 → 7 コース/オプション/ホテル → 8 出勤表 → **9 空き枠エンジン** → 10 公開空き枠表示 → 11 注文画面/仮押さえ → 12 電話受付/不成立/電話確認 → 13 送信テンプレ → 14 配車ボード/マイページ → 15 キャンセル/当日延長/キャンセル待ち → 16 顧客/指名/ポイント/引き継ぎ → 17 会計台帳 → 18 報酬 → 19 集計/突合/ヒートマップ → 20 通知/リマインド/直前割/週次 → 21 CMS内AI → 22 CTI受け口 → 23 運用文書。

**フェーズ13まででも電話注文で商売を回し始められる。**
