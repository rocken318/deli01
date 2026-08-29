# コース・オプション・ホテルマスタ 設計ノート（フェーズ7）

対象: `migrations/0006_courses_options_hotels.sql` / `src/domain/availability/hotel.ts` /
`src/domain/catalog/pricing.ts` / `tests/integration/courses-options-hotels.test.ts`
根拠: spec 3-4（オプション）・8-2（ホテルマスタ ★）・4章（データモデル）・5-2/5-3（バッファ・アルゴリズム）・18-1/18-2（ダミー値）・14章 #7・15章

## 1. テーブル（0006）

| テーブル | 要点 |
|---|---|
| `courses` | 60/90/120/150分。`price` / `nomination_fee_default` は**整数（円）**。check で負数禁止 |
| `options` | コースとは**別の実体**（spec 3-4。カスタムフィールドは使わない）。`duration_min`（0可）・`back_type`（enum `option_back_type`: 'fixed'=固定円 / 'rate'=率%）・`back_value`（rate は 0〜100 check） |
| `option_availability` | (option_id, therapist_id)。**行が無ければ全員対応**。行があれば列挙したセラピストのみ |
| `hotels` | `extra_minutes`（到着から部屋までの追加時間・分）・`is_blocked`・`entry_note`/`parking_note`。`name`/`name_kana` に text_pattern_ops index（1〜2文字の予測入力 / spec 8-2）。`area_id`/`location` は**仮登録のため null 可**（電話を止めない） |

`reservation_options` は **reservations が入るフェーズ11で追加**する。
(reservation_id, option_id, price_snapshot, duration_snapshot, back_snapshot) として、
**予約確定時に価格・時間・バックを必ずスナップショット**する（spec 3-4）。
後からオプションの値段・時間・バックを CMS で変えても、過去の予約・報酬計算は変わらない。

## 2. オプション duration_min が施術時間 L に効く（spec 3-4・5-3）

空き枠アルゴリズム（フェーズ9）の施術時間 L はコース時間ではなく
**L = コース時間 + 選択オプションの duration_min 合計**。

- `totalServiceMinutes(courseDurationMin, selectedOptions)`（`src/domain/catalog/pricing.ts`）が L を返す。
  純粋関数・整数分・不正入力（負数/小数/0分コース）は RangeError
- `totalPrice({coursePrice, selectedOptions, nominationFee?, transportFee?})` が合計金額（**整数の円**）を返す。
  小数は RangeError（CLAUDE.md 禁止事項）。深夜加算・割引はフェーズ11以降で revenue_lines 側に積む
- +30分の延長を付けたら次の予約との間隔がその分必要になる。フェーズ9は
  `s + buffer_before + L + buffer_after + travel(A→N) ≤ t_n` の L にこれを使う

## 3. ホテル extra_minutes が到着に効く（★完了条件 / spec 8-2・5-2）

`src/domain/availability/hotel.ts`（純粋関数・DB/Next.js 非依存）:

- `arrivalExtraMinutes({destinationKind, hotelExtraMinutes})`
  — 目的地が `hotel` のときだけ extra_minutes を返す。住居は常に 0。
  仮登録（未補完 = null）は 0 扱い（電話を止めない運用のためエラーにしない）
- `arrivalBuffers({mode, defaults, override?, destination})`
  — 既存 `travelBuffers`（spec 5-2: 駐車は車のみ・エリア別上書き）と合成し、
  `arrivalTotalMin = arriveMin + parkingMin + hotelExtraMin` を返す。
  フェーズ9は spec 5-3 の `s ≥ t_p + travel(P→A) + buffer_arrive` の buffer_arrive にこれを使う
- `isHotelBookable(hotel)` — `is_blocked` なら false。予約作成（フェーズ11/12）のガードと
  公開側の選択肢フィルタの両方が使う

同一距離・同一バッファでも destination=hotel(extra=12) は住居より総到着時間が
12分増える（テストで固定。住居 25分 → ホテル 37分、車・既定バッファの場合）。

## 4. RLS（docs/auth-rls.md §4 の必須セット適用）

4テーブルすべて enable + force + ポリシー + `app_runtime` grant。

| テーブル | owner/admin | reception | therapist |
|---|---|---|---|
| courses / options / option_availability / hotels | 全操作 | select | select |

- 公開側（料金表・ホテル選択）は既存パターンどおり `getClient()`（BYPASSRLS）で
  `is_active` / `is_public` / `not is_blocked` の行だけ直読み
- **spec 8-2「電話中の仮登録」で reception に hotels の insert/update を許すポリシーは
  オーダーエントリーのフェーズ12で追加**（現時点は select のみ。判断ログ対象）

## 5. シード（spec 18章 / 冪等・固定UUID upsert）

- courses 4件（18-1どおり）。`nomination_fee_default` は 18-3 の通常指名 ¥1,000
- options 5件（18-2どおり）。バックは 18-4 のオプション既定 50%（rate）、延長は 55% を仮置き、
  アロマだけ fixed ¥1,000 にして **back_type の両値をデモ**
- option_availability: フットケアのみ「あおい」限定（絞り込みのデモ）。他は行なし = 全員対応
- hotels 5件: 大型（グランドタワーホテル東京 / extra 12分・港区）・通常（渋谷 extra3 / 恵比寿 extra5）・
  `is_blocked`（ホテルノワール新宿）・仮登録（area/location null・extra 0）
- **すべて DB への初期投入。コードにハードコードしない**（CMS から変更できることをもって完成 / spec 18章）

## 6. フェーズ9（空き枠）・11（予約）への接続

1. フェーズ9: 隙間判定で `L = totalServiceMinutes(course.duration_min, options)`、
   到着条件は `travel(P→A) + arrivalBuffers(...).arrivalTotalMin`（目的地がホテルなら
   hotels.extra_minutes を渡す）。オプション対応可否は option_availability
   （行なし = 全員可）でセラピスト候補を絞る
2. フェーズ11: 予約確定時に reservation_options へ price/duration/back をスナップショット。
   `reservations.buffer_min` にも計算時の合計バッファ（館内移動込み）を控えとして保存。
   is_blocked ホテルは isHotelBookable で保存前に弾く（公開側は選択肢に出さない）
3. フェーズ12: 電話中のホテル仮登録（名前だけ insert → 後から補完）と
   reception 向け hotels insert/update ポリシー追加
4. フェーズ15: 当日延長は options の duration_min を使って後続予約への影響を判定

## 7. qa へのテスト観点（spec 15章）

1. **オプション duration_min が空き枠に反映される**（フェーズ9で本命）:
   同じ隙間で 90分コースは入るが「90+延長30」は入らない境界ケース。
   現時点は totalServiceMinutes の純関数テスト + DB 値通しテストで代理検証済み
2. **ホテル extra_minutes 加算で枠が変わる**（フェーズ9で本命）:
   同一住所相当の距離でも destination=hotel(extra>0) だと開始可能時刻が遅くなる。
   現時点は arrivalBuffers の差分（+12分）を unit / 統合の両方で固定済み
3. **is_blocked で予約不可**: isHotelBookable=false。フェーズ11で「保存時に弾く」
   「公開側の選択肢に出ない」まで通しで
4. RLS: reception/therapist が courses/options/hotels を書けない・fail-closed・
   enable+force 網羅走査（auth-rls.test.ts）が新4テーブルで通る
5. シード冪等性: `pnpm db:seed` 2回で courses 4 / options 5 / hotels 5 のまま
6. 金額整数: courses/options の price・totalPrice の結果が常に整数（小数で RangeError）

## 8. 未対応・後続（判断ログ候補）

- 管理UI（コース/オプション/ホテルの CRUD・料金表グリッド・ホテル予測入力 UI）は
  フェーズ7の完了条件外。admin-ui がスキーマ確定後に実装
- `therapist_courses`（対応可否・個人別指名料 / spec 4章）はシフト・セラピスト設定を
  拡張するフェーズ8〜9で追加（courses.nomination_fee_default を既定として上書きする設計）
- 交通費マスタ（徒歩0円・車エリア別 / spec 18-3）は予約金額が立つフェーズ11で
  site_settings かエリア属性として追加（totalPrice は transportFee を引数で受ける形で先行）

## 後続フェーズへの申し送り（reviewer 推奨）

- **rate バックの丸め（フェーズ18 / spec 11-3・18-4）**: `options.back_type='rate'` のバック額は `floor(price × back_value / 100)` で**整数円に切り捨て**る（セラピスト有利に倒さず、事業側の端数負担を避ける方針）。実装はフェーズ18（報酬計算）で `payout_lines.calc_note` に根拠を残す。
- **ホテル退出側の時間（フェーズ9 / spec 8-2・5-3）**: `hotels.extra_minutes` は「到着から部屋まで」を到着バッファに加算する（本フェーズ実装）。**部屋→エントランスの退出分**は、フェーズ9 の空き枠計算で `free_at`（travel(A→N) 側）に施術後バッファで吸収するか、退出分を別途加算するかを決める。現状は spec 文言どおり到着側のみ。
- **hotels.name の unique（フェーズ12 / spec 8-2 仮登録）**: 電話中の仮登録で同名衝突を避けるため、`(name, area_id)` 複合 unique か on conflict 運用へ変更を検討。
