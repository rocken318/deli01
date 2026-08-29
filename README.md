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
| 10 | 2026-08-29 | 3 | フェーズ3で以下を先送りにする: (a) 画像アップロード UI（現状は data-URI プレースホルダ + メタ編集のみ / Storage 未配線）、(b) 画像の WebP 変換・リサイズ、(c) ページの履歴・巻き戻し（spec 3-2）、(d) 公開時の `revalidate`（ISR 再生成）、(e) ブロックの並べ替え・複製・追加 UI（現状は見出し編集とヒーロー画像添付のみ）。ヒーロー画像は draft ブロックの `imageId` 側に一本化し、ページ fields の `heroImageId` は保持のみ（誤消去防止）で編集経路にしない | spec 14章フェーズ3の完成条件（「画像を CMS から差し替えられる」）は data-URI プレースホルダ + ヒーロー画像添付 UI + プレビュー描画で実証できるため、アップロード実配線・履歴・並べ替えは後続フェーズに回してスコープを絞る。画像の一本化は fields 側 `heroImageId` を null 上書きしていた不具合の再発防止も兼ねる |
| 11 | 2026-08-29 | 4 | セラピスト公開のセキュリティ修正と先送りの明文化: (a) **セラピストの公開経路を掲載同意ゲート付きの専用公開（`publishTherapistProfile`）に一本化**。汎用 `publishEntityRecord` は `entity='therapist'` を先頭で拒否し、`DynamicForm` の汎用「公開する」ボタンも therapist 詳細画面では `showPublish={false}` で隠す（spec 3-7）。専用公開は同意チェック前に `buildZodSchema` で draft を fail-fast 検証する。(b) シードに therapist の `image_gallery` 型 `photo` フィールド（`is_public=true` / spec 2-2「写真（複数枚）」）を追加し、minato の draft.photo に未同意メディアを入れてゲート発火を実証。(c) 同意スキャンは論理削除フィールドも対象（`deleted_at is null` フィルタ除去）、退職処理の媒体特定は draft・published 両側を走査。**先送り: 公開プレビュー導線（`/therapists/[slug]`）はフェーズ5の公開ページ実装までの暫定リンク、変更履歴・巻き戻し（spec 3-2）は未実装、顔出し可否（`face_visibility`）のセラピスト単位設定と公開側反映はフェーズ5** | セキュリティ観点で「同意ゲートを唯一の公開経路にする」ことを最優先。汎用公開・埋め込みボタン・シードの3経路すべてでゲートを迂回できないよう塞ぐ。draft 検証を同意チェックより前に置き不完全な内容の公開を防ぐ。プレビュー導線・履歴・顔出し設定は公開ページ（フェーズ5）が未実装のため後続に回す |
| 12 | 2026-08-29 | 5 | フェーズ5の設計判断: (a) 公開側に loading.tsx / error.tsx を追加（ルートグループ・therapists・therapists/[slug] の3階層）。エラー表示は ↻ 記号 + aria-label="Retry" のみで日本語ゼロ。**エラー文言のCMS化（terminology/ui_labels 経由）は後続フェーズ**（現状は記号 + 英語 aria で暫定）。(b) face_visibility フィールドを公開側で反映: none=シルエット表示、eyes=目線帯（`globals.css` に `.eye-overlay::before` を定義）、face=通常表示。シードで aoi の写真を eyes にして実証。**プレースホルダSVG段階のため最小反映（値によって表示が変わる）に留め、実写真の本格的な顔加工（目線処理・マスク合成）はアップロードUI実装フェーズで対応**。(c) JSON-LD の XSS 対策として `JSON.stringify(personLd).replace(/</g, "\\u003c")` で `</script>` 脱出を防止。**サニタイズ方針の本対応（DOMPurify 等の導入・許可タグ定義）はフェーズ21**。(d) field-value.tsx の rich_text は `dangerouslySetInnerHTML` を廃止しタグ除去のプレーンテキスト化（公開側 XSS 防止・暫定）。(e) セラピストの `name` フィールド定義（sort_order=2、**is_public=true**）と氏名値（あおい/みなと/ひなた）をシードに追加し、**個人ページの主見出し**（buildTherapistView が name を view.name に抽出）と JSON-LD Person.name に `view.name \|\| view.catchCopy \|\| slug` の優先順位で使用（一覧カードは catch_copy 表示のまま。カードの氏名表示は後続）。**JSON-LD の `url` は site_settings に base URL キーが無いため相対 `/therapists/{slug}` のまま**（base URL が入り次第、絶対URL化）。(f) **最短案内/空き枠はフェーズ9まで placeholder + force-dynamic（EarliestSlot は time=null 固定）**。古い枠を出さないため（spec 2-3 / 2-7）、値が入るまでキャッシュに乗せない。(g) **CMS ブロック画像は `getPublicMediaMap(requireConsent:false)` を許容＝ページブロックに未同意の人物写真を貼れる隙が残る**。媒体に人物/素材の区分を持たせて塞ぐのはフェーズ6以降（推奨4）。(h) **モバイル崩れの E2E（Playwright）はフェーズ11へ集約**。 | 公開側の完了条件（spec フェーズ5 / 14章）: 3状態UI・顔出し可否反映・XSS対策の3点を実装。ローディング/エラーはNext.jsのConvention（loading.tsx/error.tsx）に乗りSuspense境界を自動設定。日本語ゼロ制約を保ちつつ記号とaria-labelで視覚的に十分なフィードバックを提供。暫定対応（エラー文言CMS化・顔加工・サニタイズ本対応・空き枠実値・媒体区分・E2E）は各後続フェーズへ明示的に先送り |
| 13 | 2026-08-29 | 5 | 非公開/未同意/退職セラピストは `notFound()` で not-found ページを描画する（プロフィールデータは一切出さない＝**データ露出なし**、統合テストで getPublicTherapist が null を返すことを検証済み）。ただし **Next.js 15.5 のストリーミング配下では notFound() が HTTP ステータス 200 を返す**（本来 404 が望ましい）。当面の緩和として generateMetadata で `robots: { index:false, follow:false }` を返し検索エンジンの索引付けを防ぐ。404 ステータス化（Next のバージョン挙動/レイアウトのストリーミング境界の調査）は後続の課題 | 完了条件（直書き日本語0・スマホ崩れない）と安全要件（非公開データを出さない）は満たしている。not-found ページの HTTP 200 は SEO 上の軽微な問題であり、noindex で実害を回避。データ保護は RLS 相当の公開クエリ（published/consent/is_hidden/status 絞り）+ 統合テストで担保 |
| 14 | 2026-08-29 | 5 | 公開のDB読取ページ（/therapists・/therapists/[slug]・/courses・/areas・/guide・/faq）を `revalidate=60`(ISR) から **`force-dynamic`（リクエスト時レンダ）** に変更 | Vercel 本番ビルドが ISR ページの**ビルド時プリレンダで Supabase(東京・無料枠プーラ)へ接続し 60秒タイムアウト**して失敗した（ローカルは高速な docker DB で通過）。force-dynamic ならビルド時にDBへ接続せず、実行時（health 200 が示す通り接続可能）に描画する。spec 2-7 の ISR 最適化は、DB のコロケーション or ビルド時DB非依存の実現後に再導入する（後続課題） |
| 15 | 2026-08-29 | 6 | 移動時間の設計判断（architect）: (a) **Google Maps Distance Matrix API 未キー**（停止条件②）のため車マトリクスは手動暫定値でシード。キー提供後に一括生成→CMS上書き。(b) areas はシード10件（spec 18章の40件は本体シード拡張時）。(c) **エリア管理UI（CRUD・マトリクスグリッド・要設定一覧）は未実装**＝完了条件外のため admin-ui 後続タスク。(d) 徒歩分は切り上げ（遅刻側に倒さない）・cap ちょうど(1600m)は徒歩圏・時間帯係数区間は [from,to)。(e) セラピスト個人の徒歩上限/車可否は chooseMode の引数受けにしてありフェーズ8でカラム追加のみ | 完了条件「徒歩と車が閾値で切り替わる」を純粋関数 chooseMode（≤1600=walk / 超かつ車可=car / 超かつ車不可=unreachable）で実装、境界値1599/1600/1601＋実PostGIS距離で検証。徒歩=PostGIS毎回計算・車=マトリクス+時間帯係数の分離（spec 5-1）。空き枠エンジン（フェーズ9）はこの純粋関数＋geo.ts を使う |
| 16 | 2026-08-29 | 7 | コース/オプション/ホテルの設計判断（architect）: (a) 管理UI（CRUD・料金表グリッド）は完了条件外のため後続 admin-ui。(b) `reservation_options`（価格/時間/バックのスナップショット）はフェーズ11で追加（後からオプション値変更で過去予約が変わらない方針を 0006 冒頭に明記）。(c) `therapist_courses`（対応可否・個人別指名料）はフェーズ8-9、`courses.nomination_fee_default` を既定に上書き。(d) reception の hotels insert/update（電話中仮登録）はフェーズ12。(e) 延長バックは仮55%（ランク別レートはフェーズ18）。Google Maps 未キーはフェーズ6 #15 のまま | 完了条件「ホテルの館内移動時間が加算される」を `arrivalBuffers`（destination=hotel のとき extra_minutes を到着に加算）で実装、unit+実DBで extra=12分ちょうど増える／住居・extra=0 では増えない／is_blocked は isHotelBookable=false を検証。金額は全て integer(円)+負数check、option_availability は行なし=全員対応 |
| 17 | 2026-08-29 | 8 | 出勤予定の設計判断（architect）: (a) shifts は**1セラピスト×1日1行**（unique(therapist_id, work_date)）。分割シフトが要るなら unique を外す判断を判断ログに残す。(b) **月カレンダー・繰り返しパターン（毎週火木/隔週の一括生成 / spec 3-3）は完了条件外のため後続 admin-ui タスク**。/admin/shifts は日別の最小編集（時間・待機場所・対応エリア・上限本数・当日欠勤ワンタップ）のみ。(c) 当日欠勤時の「既存予約一覧→振替促し」は予約テーブル導入後（フェーズ11以降）。連続施術の上限も予約導入時に設計。(d) /schedule は force-dynamic（毎リクエスト読取）で「60秒以内に反映」を満たす（フェーズ5 #14 のビルド時DB非接続と同方針。ISR 60秒への切替は #14 解消後）。(e) therapists に can_use_car / walk_cap_meters を追加（フェーズ6 #15(e) の予告どおり。chooseMode に引数で渡す）。(f) therapist ロールは自分の shift のみ select/update 可（当日欠勤ワンタップの RLS。本人用 UI はフェーズ14 マイページ）。(g) 公開出勤表は「出勤時間帯＋対応可能」表示に留め、確定枠は出さない（嘘の枠を出さない / spec 2-3。フェーズ9-10 で住所前提の再計算） | 完了条件「エリアで絞れる。60秒以内に反映」を最小スコープで満たす。エリア絞り込みは shift_areas の exists 1条件に集約し、出勤表とフェーズ9 の空き枠エンジン（spec 5-3 手順1-3）が同じテーブルを読む。シードは aoi=渋谷/恵比寿/目黒のみ・ren=全域・ren+2日目欠勤・minato=未公開で「出勤していても対応エリア外/未公開/欠勤なら出ない」を実データで再現（docs/shifts-schedule.md） |

### 本番公開前チェックリスト（判断ログ #10 の解消条件）

フェーズ3で暫定対応した項目を本番前に必ず解消する:

- [ ] **ダミー画像（data-URI SVG）を本物の写真・イラストに差し替える**（`is_placeholder=true` の media 全件 / spec 3-7。実在人物の顔出しは同意フラグと顔出し可否を確認）
- [ ] 画像アップロード UI と Storage（Supabase Storage 等）を配線し、WebP 変換・リサイズを通す
- [ ] `ADMIN_DEV_SESSION` を本番で設定しない（live Supabase Auth へ差し替え）

### シード段階投入の対応表（判断ログ #5 の追跡）

spec 18章の本体シードを、対象テーブルが揃うフェーズで投入する。各フェーズの完了時にこの表を更新する。

| データ | 目標規模（spec 18章） | 投入フェーズ | 状態 |
|---|---|---|---|
| 用語辞書・サイト設定・フィールド定義 | 初期セット | 0 | ✅ 済 |
| コース / オプション / 指名・加算・交通費 | spec 18-1〜18-3 | 7 | 予定 |
| エリア40 / 移動時間マトリクス | 40エリア | 6 | 予定 |
| ホテル30 | 30施設 | 7 | 予定 |
| セラピスト25（ランク3段階・個別特例3人 / spec 18-5） | 25名 | 4 | 予定 |
| 出勤予定 | 現実的分布 | 8 | 🟡 済（直近5日分の最小デモ: エリア限定/全域/当日欠勤/未公開の4類型。25名×現実的分布は本体シード拡張時） |
| 顧客5,000（4割ポイント保有） | 5,000 | 16 | 予定 |
| 予約1年分15,000（3割オプション・土日夜偏り・指名率6割・キャンセル1割） | 15,000 | 11以降 | 予定 |
| 報酬レート・ポイント初期設定 | spec 18-4・18-6 | 18 / 16 | 予定 |
| ダミー画像（ヒーロー2・コース4・セラピスト25 / placeholder タグ） | 31点 | 3〜4 | 🟡 済（暫定 data-URI SVG。ヒーロー2・コース2・セラピスト1 を投入。本番前に本物へ差し替え） |

## 停止条件で発注者に依頼する事項（判明分）

以下は spec 停止条件②（発注者にしか用意できないもの）。未提供でも開発とCIは進むが、該当フェーズの「プレビュー/本番」到達に必要:

- **Supabase 開発プロジェクト**（URL / anon key / service role key）— 管理側 Auth、preview/production DB
- **Vercel プロジェクト**（GitHub 連携）— プレビュー URL（フェーズ0の完了条件「プレビューが出る」）
- **Google Maps Distance Matrix API キー** — 車のエリア間移動時間の初期一括生成（フェーズ6/9。未提供時は直線距離×係数の暫定値で代替）
- **Anthropic API キー** — CMS内AIアシスタント（フェーズ21）
- **メール送信プロバイダ** — リマインド・週次レポート（フェーズ20）
