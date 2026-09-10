# 配車表 作り込み（配車ボード再設計＋登録画面群＋当日給料）設計

- 日付: 2026-09-11
- 対象: 管理側「配車」まわり一式のブラッシュアップ。実運用 Excel（`Y:\deli01doc\配車表(1).xlsx`・`18期仙台回春受付表.xlsx`）を一次ソースに、現行 app を「実際に使える配車オペコンソール」へ引き上げる。
- 進め方: 大きいので **1フェーズ=1PR** に分割（後述フェーズ表）。本書は全体設計。各フェーズは本書を親に個別の実装計画を作る。
- ブレスト経緯: 視覚コンパニオンで v1〜、板/配置/登録/連携/当日給料を反復合意。モックは `.superpowers/brainstorm/1464-1789071838/content/`（gitignore 済）。

## 0. 背景と現状

- 実配車表 = 「立町（拠点）以外のホテルは送迎。移動時間を人間が入れる」運用。核は **1行=1配車**（送りLINE/キャッチLINE・女性・コース・派遣先・部屋・出発/IN/OUT・送り車/帰り車・ドライバー状態・メモ）＋上部マスタ（タクシー会社・ドライバー週次シフト・車両・伝言板・方面）。
- 現行 deli01 に有るもの: 配車ボード `/admin/dispatch-board`（reservations 直結の表・`advanceReservationStatus`・`dispatch_driver`/`dispatch_memo` 自由文字列インライン編集・`room_number`）、配車名簿 `/admin/dispatch-roster`（`taxi_companies`・`driver_messages`）、ホテル intel 208件（`hotels`＋0026）、案内表の時系列タブ埋込、報酬台帳（`payout_rates` fixed円/率%・`payout_lines` 追記・`payouts` 締め・0016）。
- 足りないもの（本設計で足す）: ①**ドライバー個人＋車両＋週次シフト**（今は会社と伝言板のみ）②**送り車/帰り車の2枠＋手動状態＋色**（今は単一自由文字列）③**退勤の自宅/寮送り**（予約でない配車ジョブ）④**送り台帳**（女性ごとの送り先/往復時間/同乗NG等）⑤**予約→配車の車要否チェック**⑥**ホテル即答リスト**⑦**当日給料（日払い精算）**⑧**左サイドバー導線**⑨**送り/キャッチLINEの生成**。

## 1. スコープ

含む: 配車ボード再設計、ドライバー/車両/週次シフト登録、送り台帳、ホテルリスト（参照）、予約↔配車連携、当日給料（日払い精算）、左サイドバー、方面グループ、送り/キャッチ LINE 生成、単一ブランド「王様の休日」＋将来ブランド追加の下地。

含まない（spec 16章の非対象を踏襲）: GPS リアルタイム追跡（状態は手動更新）、自動配車/最適化（割当は人間・D&D）、LINE 自動送信（テキスト生成＋コピーまで）、オンライン決済、ドライバーの労務/報酬計算（受付表 シート15 の走行距離/時給集計は今回やらない）。

## 2. 全体像とナビ

左サイドバー常時表示（狭幅は折りたたみ）。ブランドは「王様の休日」。
- 主要（ピン留め・上段）: **予約一覧 / 案内表 / 配車 / 当日給料**
- 運用: 出勤表 / セラピスト / ホテルリスト / 配車名簿・登録
- 会計・その他: 日次会計 / 顧客・ポイント / 設定
- 「配車」に未処理（当日・未完了配車）バッジ。

## 3. 単一ブランド／将来の複数ブランド

- 実店舗は現状「王様の休日」（略称「王様」）1つ。Excel の系列（すごい/回春/ごほうび/痴女）は他店のもの＝**UI から出さない**。
- ただし**後からブランド追加できる構造**にする:
  - 新テーブル `brands`（id, name, short_name, sort_order, is_active）。seed で「王様の休日／王様」を固定 UUID 投入。
  - 本設計の新テーブル（drivers・direction_groups 等）と将来的に therapists 等へ `brand_id`（nullable, 既定=王様）。
  - UI は**ブランドが1件の間は絞り込み/選択 UI を隠す**。2件以上で一覧フィルタ・登録時のブランド選択を出す。
- 本フェーズ群では「brands マスタ＋既定王様」を用意し、各新テーブルに `brand_id` を持たせるところまで。多ブランドの本格対応（RLS のブランド境界・ブランド別集計）は将来の別プログラム。

## 4. データモデル（新規・変更）

すべて整数（円）・`timestamptz`・`Asia/Tokyo` 前提。RLS は既存パターン（owner/admin 書込、reception 参照/一部書込、therapist 自己のみ）に合わせる。

### 4.1 brands
`brands(id, name, short_name, sort_order, is_active, created_at)`。RLS: 参照=全ロール、書込=owner/admin。

### 4.2 drivers（ドライバー＝人＋車両）
`drivers(id, brand_id→brands, name, phone, ng_note, vehicle_number, vehicle_model, vehicle_color_hex, vehicle_color_name, vehicle_note, sort_order, is_active, created_at, updated_at)`。
- 1ドライバー=1車を既定（掛け持ち/入替は将来。確認事項参照）。
- `vehicle_color_hex` が配車ボードのセル左帯・右レール・チップの色。
- RLS: 参照=owner/admin/reception（配車時に使う）、書込=owner/admin。
- 移行: 既存 `reservations.dispatch_driver`（自由文字列）は当面残置し、割当は `dispatch_legs.driver_id`（4.6）へ。旧文字列は表示フォールバックのみ。

### 4.3 driver_shift_weeks / driver_shift_days（週次シフト）
- `driver_shift_weeks(id, driver_id→drivers, week_start date, memo text, created_at, updated_at)`。`week_start` は月曜。`unique(driver_id, week_start)`。
- `driver_shift_days(id, week_id→driver_shift_weeks, dow smallint 0=月..6=日, start_min int, end_min int)`。稼働日のみ行を持つ（行が無い曜日＝休み。稼働チェック↔時間欄の連動と一致）。`start_min/end_min` は当日00:00からの分（**25時超え可**＝1440超を許容。例 27:00=1620）。
- **シフトメモ**（`driver_shift_weeks.memo`）は**消すまで翌週へ自動引き継ぎ**: 新しい週を開いた時、その週にレコードが無ければ直近の非空 memo を初期表示（保存で確定）。
- **前週をコピー**: 直前週の days＋memo を対象週へ複製。
- **当日出勤ドライバー**（配車ボード右レール）: 対象日の曜日に一致する `driver_shift_days` を持つ drivers を抽出。
- RLS: 参照=owner/admin/reception、書込=owner/admin。

### 4.4 therapist_transport / therapist_transport_routes（送り台帳）
- `therapist_transport(id, therapist_id→therapists unique, brand_id, note text, updated_at)`。`note` に同乗NG・時間帯・待合・条件付き不要（例「ごほうび ななさん同乗NG」「23時以降」「実家の日は不要」）。
- `therapist_transport_routes(id, transport_id, kind enum('home','dorm','stay'), destination text, round_trip_min int, sort_order)`。1女性に複数送り先可（自宅と寮 等）。
- 退勤送りの手動追加でここから自動補完（送り先・往復時間・note の同乗NG は警告表示）。
- RLS: 参照/書込=owner/admin/reception（配車運用データ）。therapist 本人参照は将来。

### 4.5 direction_groups（方面グループ）
`direction_groups(id, brand_id, name, sort_order, is_active)`（例「泉区・松森方面」「折立・愛子周辺」「長町・太白区中田・名取周辺」「六丁目・仙台新港周辺」）。ホテル/エリア/送り先に方面ラベルを付け、配車ボードの派遣先チップ・運転手向け LINE に出す。`hotels.direction_group_id`（nullable）を追加。RLS: 参照=staff、書込=owner/admin。

### 4.6 配車ジョブ（送り車/帰り車＋退勤送り）
現行「board 行 = reservation」を保ちつつ、**脚（leg）単位の割当**を足す。
- `dispatch_legs(id, brand_id, kind enum('reservation_send','reservation_return','send_home'), reservation_id→reservations nullable, therapist_id→therapists, work_date date, driver_id→drivers nullable, state text, depart_at timestamptz nullable, destination_text text nullable, round_trip_min int nullable, memo text, is_finished bool default false, finished_at timestamptz, created_at, updated_at)`。
  - 予約配車: `reservation_id` あり。送り＝`reservation_send`、帰り＝`reservation_return`（最大2脚）。IN/OUT/出発の時刻は reservation 側（`arrived_at`/`done_at`/`enroute_at`/`depart_at`）を正とし board が表示。
  - 退勤送り: `kind='send_home'`・`reservation_id` null・`destination_text`/`round_trip_min` は送り台帳のスナップショット・`depart_at` は手入力。1脚。
  - `state`（手動更新・脚種別で選択肢が異なる。4.7）。
  - **終了**: 予約配車は送り脚＋帰り脚が両方 `done` になったら「終了」ボタン→当該予約の全脚 `is_finished=true`（board から隠す。`?finished=1` で復帰）。退勤送りは脚 done で終了可。会計・履歴には残す。
- `reservations` に車要否フラグ: `needs_send_car bool default false`, `needs_return_car bool default false`。
  - 予約作成/編集でチェック→対応する `dispatch_legs`（send/return）を生成。チェック無し＝board に載らない（立町近隣・自力来店）。
  - 予約側でホテル/コース/時刻を変更→board 表示は reservation を正に自動追従（脚は割当/状態のみ保持）。
  - 後からチェックを外した時: 割当済み/施術後の脚は**自動削除しない**（残して手動削除）。未割当・未着手の脚のみ消してよい（確認事項）。
- RLS: 参照/書込=owner/admin/reception。therapist は配車脚を触らない。

### 4.7 ドライバー状態（手動・脚種別）
文字列 enum（`dispatch_legs.state`）。セル全面を状態色で塗り、車の識別は左色帯＋「車番＋色」表記。
- 送り車（reservation_send / send_home）: `予定 → 送り中 → 合流確認中 → インコール待機中 → バック中 → 完了`
- 帰り車（reservation_return）: `向かい中 → アウト待ち → バック中 → 完了`
- D&D 割当は**上書き**（既割当セルへ別ドライバーをドロップ→差替。状態は初期＝送り:予定／帰り:向かい中へリセット）。

### 4.8 バック単価表（当日給料）と雑費
受付表「自動精算表」に準拠＝**率でなくバック単価表 × 本数 − 雑費(10%)**。
- バック単価は既存 `payout_rates`（`calc_type='fixed'`・円）を素直に再利用。対象は `target_type`（course/option/nomination/late_night ほか）＋ `target_id`（コース/オプション個別）。既定（target_id null）＝その種別一律。延長・海外手当・指名ランク等は不足なら `payout_target_type` に値追加、または option/nomination で表現（実装計画で確定）。
- **雑費**（合計の一定率控除）を `site_settings.payout_policy` に追加: `{"misc_deduction_rate": 10}`。丸めは確認事項（既定は切り捨て想定）。
- 当日給料 = Σ(本数 × バック単価) − floor(合計 × 雑費率/100)。**本数は当日 done 予約の course/options/nomination/延長から自動集計**（手修正は例外・理由を残す）。
- 精算 = `payout_lines`（追記台帳）へ計上＋日次の支払記録。「この場で精算」で当日分を確定（既存 postReservationAccounting / settlePayout の思想に合わせ、二重計上は unique 制約で防止）。雑費は控除行（`payout_deductions` kind='other' か専用カテゴリ）で表現。

## 5. 画面仕様

### 5.1 配車ボード（`/admin/dispatch-board` 刷新）
- 1行=1配車。列: 女性 / コース(分・延長) / 派遣先(エリア＋ホテル＋方面チップ＋迎え方バッジ) / 部屋 / 出発 / IN / **送り車(＋状態＋送りLINE)** / OUT / **帰り車(＋状態＋帰りLINE)** / メモ / 状態・終了。
- **送り車を IN の隣・帰り車を OUT の隣**（送り＝出発〜IN、帰り＝OUT〜帰宅の流れ）。
- **全セル編集可**（時刻・部屋・コース・メモ）。時刻は実測(赤)／予定(灰括弧)。
- 右レール「本日出勤ドライバー」（週次シフトから自動抽出・車色帯）。**D&D で送り車/帰り車へ割当（上書き）**。
- 各車セルに **状態プルダウン**（4.7）＋**LINE 2ボタン**（🚕運転手／👩女性）。送り脚＝送りLINE、帰り脚＝キャッチLINE。
- 下段に**退勤送り**セクション（`send_home` 脚・送り台帳から往復時間自動）。
- **終了ボタン**で完了配車を一覧から隠す（復帰トグル）。遅延・退出未記録アラートは現行踏襲。
- 迎え方バッジ（1F外迎え・☆部屋番号を運転手へ・EV直行・カードキー等）は hotels intel から自動。

### 5.2 予約→配車 連携（受付/予約詳細）
- 予約フォームに「配車」ブロック: **「配車する（送り＋帰り）」既定ON**＝`needs_send_car`＋`needs_return_car`。送りにチェック→帰りも自動ON（基本ワンセット）。帰りだけ外す例外可。OFF＝board 非掲載。
- 反映は 4.6。予約変更は board が追従。

### 5.3 登録画面（`/admin/dispatch-roster` 拡張 or 新 `/admin/registry`）
共通レイアウト＝**左一覧＋右編集フォーム**（追加/保存/削除）。タブ: ドライバー / タクシー会社 / 送り台帳（女性）/ 方面グループ。
- **ドライバー**: 氏名・携帯・NG項目 ／ 車両(車番・車種・**色＝パレット選択＋カスタム**・車の注意〔色と別欄〕) ／ **週次シフト**（曜日×時間・稼働チェックON=時間欄/OFF=休み・25時超え可・**前週コピー**・**シフトメモ引継ぎ**）。
- **タクシー会社**: 既存 `taxi_companies` を一覧＋フォーム化（name/phone/shift_note/note）。伝言板 `driver_messages` は現行踏襲。
- **送り台帳**: 4.4。女性(セラピスト紐付け)＋送り先複数行＋備考。
- **方面グループ**: 4.5。

### 5.4 ホテルリスト（`/admin/hotels` を参照ビュー強化 or 新 `/admin/hotels/lookup`）
- 予約中の即答用: 名前検索＋フィルタ（実績〇/△/✖・カードキー要・ゲストチャージ有・移動確約要・方面）。
- 1行: 実績バッジ / ホテル名 / 迎え方・注意タグ / 住所 / 地図。行クリックで詳細（全履歴・チャージ額・電話・止められ記録）。
- 既存 CRUD（`/admin/hotels`・PR #90）と統合（同画面で参照・登録・編集）。予約ホテル欄への流し込みは任意（確認事項）。

### 5.5 当日給料（`/admin/todays-pay` 新規）
- 左: 本日の女性（当日バック額＋精算済/未）。右: 選択女性の当日精算（項目→単価→本数(自動)→小計、合計／雑費(10%)／支払額、手渡し現金＋「この場で精算」＋明細印刷/コピー）。
- 計算・計上は 4.8。日払い前提。

### 5.6 左サイドバー（アプリシェル）
- 2。全 `/admin/*` の外枠。既存ナビ項目を移設・整理。

### 5.7 送り/キャッチ LINE 生成
- 既存 `buildDispatchMessage`（src/domain/dispatch/message.ts）／`getBookingShareTexts`（#97）を拡張し4種を出し分け:
  - 送りLINE運転手（住所・部屋・迎え方・電話・方面）／送りLINE女性（電話番号なし・集合場所）
  - キャッチLINE運転手／キャッチLINE女性
- コピー生成まで（自動送信しない・spec 16章）。

## 6. 権限・個人情報

- 配車・登録・当日給料は `manage_reservations`/`manage_cms` 相当（owner/admin/reception）。
- 女性向け LINE は**電話番号を出さない**（運転手向けのみ電話可・spec 7-3）。住所の 180分ゲート・監査ログは現行踏襲。
- 当日給料は金銭。`payout_lines` 追記専用・締めロック・二重計上 unique を厳守（既存 0016）。

## 7. フェーズ表（1フェーズ=1PR。順序は目安）

1. **サイドバー＋ブランド下地**: 左サイドバー・ナビ整理・`brands` マスタ（既定王様）。
2. **ドライバー/車両 登録**: `drivers`＋色パレット。board のドライバー表示を `driver_id` 参照へ（旧文字列フォールバック）。
3. **週次シフト**: `driver_shift_weeks/days`・稼働連動・前週コピー・シフトメモ引継ぎ・当日出勤抽出。
4. **配車ボード再設計**: 送り車/帰り車2脚（`dispatch_legs`）・D&D割当（上書き）・状態プルダウン・セル状態色・終了/アーカイブ・全セル編集・LINE 2ボタン枠。
5. **予約→配車連携**: `needs_send_car`/`needs_return_car`・自動脚生成・予約変更追従。
6. **送り台帳＋退勤送り**: `therapist_transport(_routes)`＋board の手動追加（send_home）。
7. **ホテルリスト**: 参照ビュー（検索/フィルタ/詳細）・CRUD 統合。
8. **当日給料**: バック単価表（payout_rates fixed）＋自動集計＋雑費10%＋精算（payout_lines/日次）。
9. **方面グループ＋LINE 4種**: `direction_groups`・`buildDispatchMessage` 拡張（送り/キャッチ×運転手/女性）。

フェーズ1〜4で「板として実用」、5〜6で「予約連携＋退勤送り」、7〜9で仕上げ。

## 8. 確認事項（実装計画で確定 or 発注者確認）

1. **雑費**: 10%固定でよいか／端数の丸め（切捨て想定）。金銭のため要確認。
2. バック単価表: 延長・海外手当・指名ランク等の表現（`payout_target_type` 追加 vs option/nomination 流用）。女性ごとに単価が違うケースの有無（`payout_rates` の therapist_id 個別で吸収可）。
3. 当日精算の**取消/再精算**の可否（追記台帳＝逆仕訳で戻す運用か）。
4. 予約の車要否を後から外した時の未着手脚の自動削除可否。
5. ドライバーの車 掛け持ち/入替運用の有無（1ドライバー=1車を崩すか）。
6. ホテルリストから予約ホテル欄への流し込みを入れるか。
7. 退勤送りの出発時刻の初期値（最終アウト＋余裕 / 空欄手入力）。

## 9. 非目標（再掲）

GPS 追跡・自動配車/最適化・LINE 自動送信・オンライン決済・ドライバー労務/報酬集計は本プログラムでは作らない。
