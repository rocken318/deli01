# 出勤予定・出勤表 設計ノート（フェーズ8）

対象: `migrations/0007_shifts.sql` / `src/domain/availability/shift.ts` / `src/lib/schedule/queries.ts` /
`src/lib/cms/shift-actions.ts` / `src/app/(public)/schedule/` / `src/app/(admin)/admin/shifts/` /
`tests/integration/shifts-schedule.test.ts`
根拠: spec 3-3（出勤設定）・2-1/2-3（出勤表）・5-3（アルゴリズム入力）・4章（データモデル）・
2-7（キャッシュ）・14章 #8（完了条件）・15章（テスト必須箇所）

## 1. データの流れ: shift → shift_areas → 出勤表

```
管理 /admin/shifts（saveShiftAction / setShiftDayOffAction）
  └ shifts        1セラピスト×1日 1行（unique(therapist_id, work_date)）
      ├ start_at / end_at   timestamptz（日跨ぎは end が翌日。文字列で計算しない）
      ├ base_start_id / base_end_id → bases（待機開始/終了場所）
      ├ max_bookings        1日の最大施術本数（null = 上限なし）
      └ is_day_off          当日欠勤ワンタップ。行は消さない
  └ shift_areas   その日に対応できるエリア（全域とは限らない / spec 3-3）

公開 /schedule（listDailySchedule / force-dynamic）
  条件: work_date = 指定日
     AND is_day_off = false
     AND therapists.status = 'active'
     AND entity_records.published is not null   -- 未公開・退職は出さない
     AND（area 指定時）exists (shift_areas where area_id = 指定エリア)
```

- **完了条件「エリアで絞れる」**: area パラメータの exists 絞り込みがすべて。
  **出勤していても shift_areas に無いエリアでは一覧に出ない**（spec 15章。
  シードの aoi = 渋谷/恵比寿/目黒のみ対応が実データのデモ）。
- **完了条件「60秒以内に反映」**: /schedule は `force-dynamic`（キャッシュなし）で
  毎リクエスト DB を読む。保存 → 次のリクエストで即反映（spec 2-7 の「出勤予定 60秒
  キャッシュ」の上限内。フェーズ5 判断ログ #14 のビルド時DB非接続の方針にも一致）。
  ISR 60秒への切替は DB コロケーション解決後の後続課題（#14 と同じ扱い）。
- 公開側は `getClient()`（BYPASSRLS）直読みだが、読む列は published なプロフィールと
  shift の時間帯・エリアのみ（`src/lib/public/queries.ts` と同じ published-only 原則）。
- 表示は「出勤時間帯 + 対応可能バッジ + 対応エリア」に留める。**確定の空き枠は
  出さない**（嘘の枠を出さない / spec 2-3。フェーズ9-10 で住所前提の再計算を実装）。

## 2. 純粋関数（src/domain/availability/shift.ts）

| 関数 | 役割 |
|---|---|
| `shiftInstants(workDate, "HH:MM", "HH:MM")` | 営業日 + JSTローカル時刻 → start_at/end_at。終了 ≤ 開始は日跨ぎとして翌日へ。CHECK (end_at > start_at) と同じ不変条件 |
| `formatShiftTimeRange(startAt, endAt)` | "10:00 - 19:00"（等幅・ロケール非依存。表示のみ） |
| `remainingSlots(maxBookings, bookedCount)` | 上限本数の残り。null = 無制限。フェーズ9 の手順3「上限本数に達していれば空」がこれを使う |
| `localDateISO / addDaysISO / weekdayIndex / parseDateISO` | Asia/Tokyo 基準の日付ユーティリティ（サーバ OS の TZ に依存しない） |

曜日の表示文字は `ui_labels.schedule_weekdays`（CMS）から引く。ドメインは番号のみ返す。

## 3. セラピスト個人の移動設定（0007 で therapists に追加）

フェーズ6 判断ログ #15(e) の予告どおり:

- `can_use_car boolean not null default true` — false は徒歩圏の予約のみ（spec 5-1）
- `walk_cap_meters integer null` — null は `walk_settings.cap_meters` の既定

フェーズ9 は `chooseMode(距離, { capMeters: walk_cap_meters ?? walk_settings.cap_meters,
canUseCar: can_use_car })` とそのまま渡す（関数側の変更不要）。
シード: aoi = 車不可（徒歩派）、ren = 車可（全域対応）。

## 4. フェーズ9（空き枠エンジン）が shift をどう使うか（spec 5-3 との対応）

```
1. shift を取得。無ければ空          → shifts（work_date で1行。is_day_off も空扱い）
   B_start / B_end                   → base_start_id / base_end_id（bases.location が座標）
   対応エリア                        → shift_areas
   上限本数                          → max_bookings
2. A が対応エリアに含まれるか        → shift_areas に area_id があるか（出勤表と同一条件）
3. 上限本数チェック                  → remainingSlots(max_bookings, その日の予約数) === 0 なら空
5. gap0 の起点 / gap_n の終点        → start_at（B_start にいる）/ end_at（B_end へ帰り着く締切）
   ※ gap_n は「帰れること」まで条件に入れる（travel(A→B_end) を引く）
```

- 日跨ぎシフト（end_at が翌日）は tstzrange 的にそのまま扱える（work_date は
  「その営業日」の索引キーであって時間計算には使わない）。
- shifts は**予定**。実績（attendances / spec 3-5）は別テーブルで後続フェーズ。

## 5. RLS（docs/auth-rls.md §4 の必須セット適用）

| テーブル | owner/admin | reception | therapist |
|---|---|---|---|
| shifts | 全操作 | select | **自分の行のみ select / update**（当日欠勤ワンタップ / spec 3-3。insert/delete は不可 = シフト作成・削除は運営） |
| shift_areas | 全操作 | select | 自分の shift の行のみ select（エリア付替は運営のみ） |

- therapist の「自分」は `app_users.therapist_id`（GUC の user id から引く）。update の
  with check で therapist_id の付け替えも防ぐ。
- enable + force + app_runtime grant 済み。網羅は auth-rls.test.ts の pg_class 走査が検査。
- シードでダミー therapist アカウントを aoi に紐付け（RLS テストの前提）。

## 6. シードの配置意図（tests が前提にする）

シード実行日（Asia/Tokyo）を基準に**相対日付で5日分**入れる（いつ流してもデモが生きる）:

| セラピスト | 公開 | 出勤 | 対応エリア | 意図 |
|---|---|---|---|---|
| aoi | published | +0〜+4 10:00-19:00（上限3本・事務所発着） | **渋谷区・恵比寿駅・目黒区のみ** | 「渋谷は対応するが八王子は対応しない」→ area=八王子市 で消える（完了条件のデモ） |
| ren | published | +0〜+4 12:00-22:00（上限なし・新宿駅発着） | 全10エリア | 八王子で絞っても出る。**+2日目は is_day_off=true**（当日欠勤の例） |
| minato | 未公開 | +0〜+2 17:00-23:30 | 新宿区・中野区 | 出勤していても published が無ければ公開出勤表に出ない |
| hinata | retired | なし | — | 退職除外（フェーズ4から継続） |

冪等性: shifts は unique(therapist_id, work_date) への upsert、shift_areas は全置換。

## 7. qa へのテスト観点（spec 15章 / フェーズ8完了条件）

1. **「出勤していても対応エリア外なら一覧に出ない」**（spec 15章の明記事項）:
   `listDailySchedule(today, 八王子市)` に aoi が出ず、ren は出る（★のテスト）
2. **60秒反映**: is_day_off を切り替えた直後のクエリで一覧が変わる（キャッシュに乗らない）
3. published-only: minato（出勤あり・未公開）が出ない / hinata（退職）が出ない
4. 当日欠勤: is_day_off=true の日はその人だけ消える
5. RLS actor 別: therapist 自分のみ select/update・他人 update 0行・insert 拒否、
   reception select のみ、withUser なし fail-closed、owner 全操作
6. 純粋関数: 日跨ぎシフト（17:00-01:00）・上限残り（null/0クリップ）・日付境界（月跨ぎ/年跨ぎ）
7. シード冪等性: `pnpm db:seed` 2回で shifts 13行のまま
8. フェーズ9 で追加: max_bookings と予約数の突合、base の座標を使った gap0/gap_n、
   日跨ぎシフト × 深夜係数（spec 15章「終電跨ぎ」）

## 8. 未対応・後続（README 判断ログ #17）

- **月カレンダー・繰り返しパターン**（毎週火木・隔週の一括生成 / spec 3-3）は完了条件外。
  /admin/shifts は日別の最小編集のみ。カレンダー UI とパターン生成は admin-ui の後続タスク
- 当日欠勤時の「既存予約の一覧表示 → 振替を促す」（spec 3-3）は予約テーブル導入後
  （フェーズ11以降）
- 連続施術の上限（spec 3-3）は予約が入るフェーズ9-11 で設計（カラム追加のみで済む想定）
- 公開出勤表の「直近2週間カレンダー表示」（spec 2-3）は現状7日タブ + date パラメータ
  （2週間先まで受け付ける）。個人ページへのカレンダー埋め込みはフェーズ9-10 と合わせて
- therapist 本人用の欠勤ワンタップ UI（マイページ / spec 7-4）はフェーズ14。
  RLS（自分の shift を update 可）は先行して用意済み

## 後続への申し送り（reviewer 推奨）

- **therapist の shifts 更新は列制限が必要（フェーズ14 / spec 3-3）**: RLS は列を絞れないため、現状 therapist 本人は自分の shift の全列（start_at/end_at/max_bookings/base_*/note）を更新できてしまう（therapist_id 付替は with check で防止済み）。仕様上 therapist に許すのは「当日欠勤ワンタップ（is_day_off のみ）」。マイページUI（フェーズ14）実装前に、is_day_off だけ許す専用 Server Action か BEFORE UPDATE トリガーで列を制限する。
- **実在日付の検証**: 公開 `listDailySchedule` は `isRealDate` で 2026-02-31 等を空返しにした（Postgres の date キャストエラー防止）。admin の shift-actions も同様に強化を検討（現状は can(manage_cms) ガードで露出は限定的）。
- **areaId フォールバック**: `listDailySchedule` は不正 areaId を絞り込みなしにフォールバックする。ページ側で areas 照合済みだが、直接呼び出しでは fail-closed（空返し）の方が安全。
