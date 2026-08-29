# 予約・仮押さえ・確定・ファネル計測 設計ノート（フェーズ11）

対象: `migrations/0008_reservations.sql` / `src/domain/booking/` / `src/lib/booking/` /
`src/lib/availability/reservation-data.ts` / `src/app/(public)/booking/` /
`tests/integration/reservations-holds.test.ts`
根拠: spec 4章（reservations・exclusion・楽観ロック）・5-5（仮押さえ）・6章（予約フロー）・
9章（顧客・住所）・15章（同時2リク・楽観ロックのテスト）・付録B-2（ファネル計測）

## 1. exclusion 制約の仕組み（★同時実行の安全性の核）

同一セラピストの占有区間の重複は**アプリではなく DB が裁定する**。

```sql
alter table reservations add constraint no_therapist_overlap
  exclude using gist (
    therapist_id with =,
    tstzrange(depart_at, free_at, '[)') with &&
  ) where (status in ('held','confirmed','enroute','in_service','done'));
```

- 占有区間は `start_at〜end_at` ではなく **`depart_at〜free_at`**（spec 4章。施術時間だけを
  持つと移動中が空きに見える）。engine の `AvailableSlot` が出す depart/free をそのまま写す
- `'[)'` 半開区間なので **`free_at` = 次の `depart_at` の隣接は重複でない**（連続予約が組める）
- `where` 句で `noshow` / `cancelled` は占有から外れる（枠が空く）
- **完全同時の insert 同士は、GiST の投機的エントリを互いに待ち合って deadlock（40P01）に
  なることがある**。Postgres が片方を中断するので「片方だけ成功」という裁定自体は保たれる。
  `createHold` は 40P01/40001 を1回だけ再計算からリトライし、勝者の行が見えれば
  `slot_gone`、まだ競れば 23P01 → `slot_taken` に収束させる
- 生の Postgres エラーは画面に出さない。`23P01` + `no_therapist_overlap` を列挙コード
  `slot_taken` に変換し、表示文言（「他のお客様の予約が先に確定しました」）は CMS の
  `ui_labels.booking_error_slot_taken` が持つ（公開側 直書き日本語0 / spec 4章・13-1）

## 2. ホールド方式（spec 5-5）

**ホールド＝`reservations` に `status='held'` の行**。exclusion 制約がそのまま防衛線になる。
別テーブルのロックでは同時 insert の競合を DB が裁定できない。

- `slot_holds` は**追跡専用**の併設テーブル: `session_id`（誰のホールドか）と
  `expires_at`（10分 / `HOLD_MINUTES`）を控える。held 行と 1:1（`reservation_id` unique,
  on delete cascade）
- 期限切れの解放は三重:
  1. `release_expired_holds()`（SQL 関数）が期限切れ held を**行ごと削除**。
     `createHold` / `confirmReservation` の冒頭で毎回呼ぶ（期限切れ held が exclusion の
     占有として残ると空いたはずの枠が取れないため、insert 前の解放が必須）
  2. 参照時の除外: `loadActiveReservations` が期限切れ held を engine に渡さない
     （cron 前でも枠として案内できる）
  3. cron 配線はフェーズ20（関数は本フェーズで用意済み）
- 確定時に `slot_holds` 行は削除（held でなくなった行は期限切れ削除の対象外になる）
- 「別の時間を選び直す」導線用に `releaseHold`（session 一致の held のみ削除）を用意

## 3. 楽観ロック（spec 4章・15章）

`reservations.version integer not null default 0`。更新は必ず

```sql
update reservations set ..., version = version + 1
where id = $1 and version = $2 and status = 'held'
```

0 行更新 = 競合として `version_conflict` を返す（`ConfirmAbort` でトランザクションごと
ロールバックし、顧客・住所の片肺書き込みを残さない）。確定は `select ... for update` で
同一ホールドへの並走確定も直列化している（楽観ロックは「古い画面からの保存」を、
行ロックは「同一リクエストの二重送信」を止める）。

## 4. engine 出力 → reservations の写像

| engine (`AvailableSlot`) | reservations |
|---|---|
| `startAt`（案内開始 s） | `start_at` |
| `serviceEndAt`（s + buffer_before + L） | `end_at` |
| `departAt`（s − 到着バッファ − travel_in） | `depart_at` ★占有下端 |
| `freeAt`（s + before + L + after） | `free_at` ★占有上端 |
| `travelInMin` / `travelOutMin` | `travel_in_min` / `travel_out_min` |
| `bufferTotalMin` | `buffer_min` |

逆方向（DB → engine）は `loadActiveReservations` が `ExistingReservation`
（departAt / freeAt / place=エリア代表点）に写す。**held は場所つきで `reservations` 入力に
渡す**（engine の R-3 契約。`holds` 入力に流すと前後の移動可否に算入されない）。
`buildTravelDataSource` が「目的地 ↔ 待機場所・既存予約エリア」の PostGIS 距離と
`area_travel_times` の実マトリクスを一括で解決する（フェーズ10 までの暫定値経路から前進）。

## 5. 住所での確定枠再計算（spec 6章 手順5・現状の割り切り）

- 本フェーズの目的地は**エリア代表点**（`areas.center`）、ホテル指定時は `hotels.location` +
  `extra_minutes` 加算（spec 8-2。`getTherapistSlots` の `hotelId` 引数）
- 個別住所のジオコーディング（住所文字列 → 座標）は未配線（Google API キー未提供）。
  `addresses.location` は null で保存し、配線後に
  「住所入力 → `PlaceRef`（addr:id, 座標距離）で engine 再計算 → 枠維持 or 近い代替枠を提示」
  に精緻化する。`TravelDataSource` と `PlaceRef` はそのまま使える設計にしてある
- 精緻化までは「エリア代表点で成立する枠」をホールドし、住所は確定時に控える運用

## 6. 料金（spec 6章 手順9 / 18-3）

- 純関数 `src/domain/booking/fees.ts`: 交通費（徒歩0 / 車1,000）・深夜加算
  （0:00〜5:00 **開始** +3,000 / Asia/Tokyo 壁時計判定）・`feeBreakdown` 合計。すべて整数円
- 設定は `site_settings.booking_fees`（CMS から変更が正 / seed は spec 18-3 のダミー値）
- 指名料は `courses.nomination_fee_default`（公開フローで特定セラピストを選ぶ＝通常指名）。
  個人別特別指名・therapist_courses の上書きはフェーズ16/18
- オプションは**ホールド時に** `reservation_options` へ価格・時間・バック（type+value）を
  スナップショット（spec 3-4。L の計算に使った内容と金額が必ず一致する）。
  back を jsonb でなく2列にしたのは報酬計算（フェーズ18）で型を保証するため
- ポイント値引（手順8）はフェーズ16。UI の合計行構成はそのまま拡張できる

## 7. ファネル計測（付録B-2）

- `funnel_events`（追記専用）: visit → view_therapist → select_slot → hold → confirm
- visit / view_therapist / select_slot はクライアント発火（`trackFunnel` Server Action +
  `FunnelPing`）。**hold / confirm は取引と同一トランザクション内で記録**（計測と実態が
  必ず一致する）
- `session_id` は匿名 UUID（sessionStorage）。個人情報を持たない
- 集計画面（離脱地点の可視化）はフェーズ19

## 8. RLS（docs/auth-rls.md §4 の必須セット準拠）

| テーブル | owner/admin/reception | therapist | 備考 |
|---|---|---|---|
| customers / addresses | 全操作 | 担当予約に紐づく行のみ select | 住所は機微（spec 13-3）。180分ゲート+監査はフェーズ14/16 |
| reservations / reservation_options | 全操作 | 自分の担当のみ select | ステータス更新はフェーズ14 |
| slot_holds | 全操作 | なし | |
| funnel_events | owner/admin select のみ | なし | 追記専用（update/delete は grant ごと revoke） |

公開側の予約作成は Server Action（server-only モジュール）経由の特権接続 + Zod 検証
（既存の公開読み取りと同じ方針。クライアントから直接 DB は触らない）。
0001 の default privileges が全 CRUD を配るため、追記専用テーブルは**明示 revoke が必要**
（funnel_events で対応。audit_logs 同型）。

## 9. フェーズ12/16 への接続

- **フェーズ12（電話受付）**: 受付の手動予約は同じ `reservations` に insert（exclusion が
  同様に守る）。枠外予約（override）は `can('override_slot')` + 理由 + audit。電話注文は
  保存時に `phone_confirmed_at` 自動セット（カラム追加はフェーズ12 のマイグレーション）
- **フェーズ16（顧客・ポイント）**: `customers` の電話番号名寄せが基盤。ポイント値引は
  `feeBreakdown` にマイナス項を足し、`point_entries` 台帳と接続。指名NG・特別指名料は
  ホールド時の指名料解決に差し込む
- **フェーズ14（配車ボード）**: status 遷移（confirmed→enroute→…）は versioned update を
  そのまま使う。therapist の自分の予約 update ポリシーを追加する

## 10. 残 UI / 判断ログ候補

- 注文フローは spec 6章の順序を1画面のプログレッシブ開示で実装（完了条件を満たす実用最小）。
  「誰でもいい」候補提示・キャンセルポリシー同意チェック・会員登録案内・ポイント利用は
  後続フェーズ（それぞれ 12/15/16）で追加
- 個人ページの枠 → `/booking?t={slug}` でセラピスト事前選択
- E2E（Playwright）は未導入のまま（統合テストが Server Action の実体
  `createHold`/`confirmReservation` を実 Postgres で直接叩いて完了条件を検証している）

## 後続への申し送り（reviewer 推奨 / 必須条件）

- **【フェーズ14着手前に必須】addresses/customers の therapist RLS を精緻化（spec 13-3・7-3）**: 現状は「担当予約が1件でもあれば（cancelled/noshow 含む）住所・電話番号を何日前でも select 可」。spec 13-3 は「担当セラピストにのみ、予約の**3時間前から**表示・閲覧は監査ログ」、7-3 は「顧客の電話番号をセラピスト端末に残さない（列制御）」。**セラピスト向けマイページ（フェーズ14）を載せる前に、`now() >= start_at - interval '180 minutes'` ゲート＋ status 絞り＋電話番号列の制御＋閲覧監査を必ず実装する。** capability の `view_customer_address`（180分）は domain 層に既にある。
- **顧客氏名の上書き防止（対応済み）**: 既存顧客の name は上書きせず、空のときだけ補完（未検証Web入力で自動補完データを汚さない / 推奨2）。
- **【公開前チェックリスト】公開 Server Action のレート制御（推奨3）**: `holdSlot`/`trackFunnel` は匿名で叩けるため、セッション量産で全枠を10分ホールドし続ける営業妨害・funnel_events 肥大が可能。公開前に「セッションあたり同時ホールド数上限／簡易レート制限」を入れる。
