# エリア・移動時間・バッファ 設計ノート（フェーズ6）

対象: `migrations/0005_areas_travel.sql` / `src/domain/availability/travel.ts` / `src/lib/availability/geo.ts` / `tests/integration/areas-travel.test.ts`
根拠: spec 5-1（移動手段）・5-2（バッファ）・5-3（アルゴリズムとテスト）・3-8（エリア管理）・4章（データモデル）・18章（シード）

## 1. 徒歩と車を同じ仕組みで扱わない（spec 5-1）

| | 徒歩 | 車 |
|---|---|---|
| 算出方法 | **PostGIS で毎回計算**（マトリクスにしない） | **エリア間マトリクス + 時間帯係数** |
| データ | `walk_settings`（迂回係数・分速・上限） + `walk_overrides`（分断区間の例外） | `area_travel_times` + `travel_time_modifiers` |
| 式 | `徒歩分 = ceil(直線距離m × 迂回係数 ÷ 分速)` | `車分 = max(0, ceil(マトリクス分 × multiplier) + additional)` |
| 未登録時 | 常に計算できる（座標があれば） | 直線距離 × 係数の暫定値（`provisionalCarMinutes`）。管理画面に「要設定」表示（後続） |

- 既定値（シード / CMS で調整可）: 迂回係数 **1.30**、分速 **80 m/分**、徒歩上限 **1600 m ≒ 26分**
- 端数は**常に切り上げ**る。移動を短く見積もると遅刻側に倒れるため
- 川・線路・幹線道路の分断は `walk_overrides.added_minutes`（エリア対単位、例: 橋 +8分）で上書き

## 2. chooseMode の閾値（フェーズ6 完了条件）

```
距離 ≤ cap_meters（既定1600）          → 'walk'
距離 > cap_meters かつ 車可           → 'car'
距離 > cap_meters かつ 車不可         → 'unreachable'（徒歩圏の予約しか受けない）
```

- 境界は **cap ちょうどを徒歩圏に含める**（1599/1600 → walk、1601 → car）。テストで固定済み
- cap はセラピスト個人ごとに上書き可能な設計（`chooseMode` は capMeters を引数で受ける。
  個人差カラムはセラピスト設定を拡張するフェーズで追加）

## 3. 時間帯係数（travel_time_modifiers）

- 区間は `[time_from, time_to)`。**`time_from > time_to` は日跨ぎ**（例 23:00〜05:00）として
  `pickTimeModifier` が解釈する。時刻は Asia/Tokyo のローカル "HH:MM"（呼び出し側が date-fns-tz で変換）
- シード: 深夜 23:00〜05:00 **×0.75**（道が空くので昼より速い）/ 朝 07:00〜09:30 ×1.40 / 夕 17:00〜19:30 ×1.30
- 複数該当時は `sort_order` の先頭を採用。該当なしは係数なし（素のマトリクス分数）

## 4. バッファ（spec 5-2 / travel_buffers）

- 既定1行（scope='default'）: 到着前10 / **駐車15（車のみ）** / 施術前5 / 施術後10
- エリア別上書き（scope='area'）: シードでは港区の駐車を20分に（都心は駐車場探しが長い）
- **駐車バッファは `travelBuffers()` が mode='walk' のとき 0 にする。** DB には常に値を持ち、適用時に落とす
- 一意性: default は部分 unique index で1行のみ、area は area_id ごとに1行

## 5. DB / ドメインの境界

```
src/lib/availability/geo.ts   … PostGIS（ST_Distance, geography）→ 距離(m) を返すだけ
src/domain/availability/*.ts  … 距離・分数・係数を受け取る純粋関数（DB/Next.js 非依存）
```

- `geo.distanceMeters(from, to)`: 経緯度2点間のメートル（WGS84 楕円体）
- `geo.distanceMetersBetweenAreas(fromId, toId)`: `areas.center` 間。center 未設定なら null
- geography の DDL は SQL マイグレーションが正。Drizzle 側は customType（テキスト写像）

## 6. フェーズ9（空き枠エンジン）がこれをどう使うか

spec 5-3 の `travel(P→A)` は次の手順で求める:

1. P・A の座標（顧客住所 `addresses.location` / エリア代表点 / `bases.location`）から
   `geo.distanceMeters` で直線距離を取る
2. `chooseMode(距離, {capMeters: walk_settings.cap_meters（個人上書きがあればそれ）, canUseCar})`
3. walk → `walkMinutes(距離, walk_settings)` + `walk_overrides` の該当区間 added_minutes
4. car → `area_travel_times[fromArea][toArea]`（未登録なら `provisionalCarMinutes`）を
   `pickTimeModifier(modifiers, 出発時刻のHH:MM)` → `carMinutes` で補正
5. unreachable → その隙間は候補から除外
6. `travelBuffers({mode, defaults, override: エリア別行})` を移動の前後に加算
   （到着前+駐車は施術開始前、施術後は次の移動前。ホテルの extra_minutes はフェーズ7で加算）
7. `reservations.travel_in_min / travel_out_min / buffer_min` に計算時の値をスナップショット

## 7. シードの配置意図（tests が前提にする）

- エリア10件: 都心8区 + 恵比寿駅 + 八王子市。**目黒区代表点↔恵比寿駅 ≒ 1.2km（walk 圏内）**、
  **渋谷区↔八王子市 ≒ 34km（車60分 / 車不可なら unreachable）** で閾値切替を実データで実証
- マトリクスは代表14ペア × 双方向 = 28行。豊島区↔品川区などは意図的に未登録（暫定値経路のデモ）
- Google Maps Distance Matrix API は**未キーのため手動の暫定値**（停止条件②に該当。判断ログ記載）。
  キー提供後に一括生成 → CMS 上書きの順で精度を上げる

## 8. RLS（docs/auth-rls.md §4 の必須セット適用）

7テーブルすべて: enable + force + ポリシー + `app_runtime` grant。

| テーブル | owner/admin | reception | therapist |
|---|---|---|---|
| areas / area_travel_times / walk_settings / walk_overrides / travel_time_modifiers / bases / travel_buffers | 全操作 | select | select |

公開側（/areas 等）は既存パターンどおり `getClient()`（BYPASSRLS）で公開可能な列のみ直読み。

## 9. qa へのテスト観点（spec 5-3 の移動系 / 15章）

1. **閾値切替（完了条件）**: 1599/1600/1601m で walk/walk/car。車不可は 1601m で unreachable
   （`src/domain/availability/travel.test.ts` + 実データは `tests/integration/areas-travel.test.ts`）
2. **深夜係数**: 同じ経路で 01:00 の車移動 < 13:00 < 08:00（0.75 / 1.0 / 1.4）。日跨ぎ区間の境界
   （23:00 は該当・05:00 は非該当）
3. **駐車バッファは車のみ**: walk で parkingMin=0、エリア上書き（港区20分）が既定より優先
4. **切り上げ**: 分数が常に整数で、端数が切り捨てられていない（1000m → 17分）
5. **RLS**: reception/therapist が書けない、withUser なしで見えない（fail-closed）、
   enable+force 網羅走査（auth-rls.test.ts）が新7テーブルで通る
6. **シード冪等性**: `pnpm db:seed` 2回で areas 10行・マトリクス28行のまま
7. フェーズ9で追加: 終電跨ぎ・「帰れない枠の除外」への係数の効き方（spec 15章「時間帯係数、終電跨ぎ」）

## 10. 未対応・後続

- 管理UI（エリアCRUD・マトリクスグリッド・「要設定」一覧・エリア別対応可能人数）はフェーズ6の
  完了条件外。admin-ui がスキーマ確定後に実装（判断ログ）
- セラピスト個人の徒歩上限・車可否カラム（spec 5-1「セラピストごとの設定」)はシフト/セラピスト
  設定を拡張するフェーズ8で追加（chooseMode は引数で受けるため関数側の変更は不要）
- 交通費（徒歩0円・車エリア別固定）は料金系のフェーズ7で
