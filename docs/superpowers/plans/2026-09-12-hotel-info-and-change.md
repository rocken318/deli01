# 配車ボード/予約一覧でホテル情報の展開＋ホテル変更 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 派遣先ホテル名をクリックすると、その場で下に展開して (A) **ホテル情報**（迎え方・カードキー要否・ゲストチャージ・入店注意/履歴・住所・地図・交通費）が見え、(B) **ホテルを変更**できる（**交通費も自動で新しい額に更新**・変化を画面表示）。配車ボードと予約一覧の両方に付ける。

**Architecture:** ホテル情報は既存 `listHotelsLookup`（フェーズ7・intel 付き read-only）を再利用。ホテル変更は `changeReservationHotel` を新設＝`hotel_id` を更新し、**交通費を再解決（ホテル個別 `hotels.transport_fee` > エリア既定 `areas.transport_fee`）**、`reservations.transport_fee` と `total_amount` を差分更新、`area_id` も新ホテルのエリアに追従、`audit_logs` 記録。マイグレーション無し。金額は整数。

**Tech Stack:** Next.js 15 / TS / postgres.js / RLS / Zod / Vitest。発注者確定: **交通費は自動更新**。

---

## 前提（実装者は該当ファイルを読む）
- `src/lib/hotels/hotel-lookup-actions.ts` `listHotelsLookup()` → `HotelLookupRow{ id,name,areaName,address,entryNote,cardKeyRequired,guestChargeNote,accessNote,mapsUrl,isBlocked,record }`（フェーズ7）。**`transport_fee` は返していないので追加する**（`hotels.transport_fee`／0039）。
- 交通費の解決規則（0039・`src/lib/booking/holds.ts`）: **ホテル個別 `hotels.transport_fee`（非null）> エリア既定 `areas.transport_fee`**。徒歩圏は 0。
- `reservations`: `hotel_id`, `area_id`, `transport_fee`, `total_amount`, `version`。`src/lib/dispatch-board/queries.ts`（board は `hotelName` を返す）、`src/lib/reservations/list-actions.ts`（一覧は `hotelName`/`transportFee`/`totalAmount`）。
- 既存の担当変更 `src/lib/reservations/therapist-actions.ts` が**同型の実装例**（version 更新・audit_logs・ActionResult・23P01 ハンドリング）。これに倣う。
- UI: `src/app/(admin)/admin/dispatch-board/DispatchBoardClient.tsx`（派遣先セル）、`src/app/(admin)/admin/reservation-list/ReservationListClient.tsx`（派遣先セル・既に詳細モーダル/担当変更あり）。

## File Structure
- Modify `src/lib/hotels/hotel-lookup-actions.ts`（`transportFee` を返す）
- Create `src/lib/reservations/hotel-actions.ts`（`changeReservationHotel`）＋ `tests/integration/ztest-hotel-change.test.ts`
- Create `src/app/(admin)/admin/_components/HotelInfoPanel.tsx`（共通 client: 情報表示＋変更）
- Modify `src/app/(admin)/admin/dispatch-board/{page.tsx,DispatchBoardClient.tsx}`
- Modify `src/app/(admin)/admin/reservation-list/{page.tsx,ReservationListClient.tsx}`

---

## Task 1: ホテル情報に交通費を追加

**Files:** Modify `src/lib/hotels/hotel-lookup-actions.ts`

- `HotelLookupRow` に `transportFee: number | null`（ホテル個別・null=エリア既定）と `areaTransportFee: number | null`（参考表示用）を追加。
- select に `h.transport_fee`、`ar.transport_fee as area_transport_fee` を追加してマップ。
- **実効交通費** = `transportFee ?? areaTransportFee ?? 0`（UI で使う）。

- [ ] **Step 1:** 実装＋`pnpm typecheck`＋既存 `ztest-hotel-lookup.test.ts` 緑。
- [ ] **Step 2:** `git add src/lib/hotels/hotel-lookup-actions.ts && git commit -m "feat(hotels): ホテル参照に交通費（個別/エリア既定）を追加"`

---

## Task 2: ホテル変更アクション（TDD）

**Files:** Create `src/lib/reservations/hotel-actions.ts`, `tests/integration/ztest-hotel-change.test.ts`

仕様（manage_reservations）:
- `changeReservationHotel({ reservationId, hotelId })`:
  - 対象は `held/confirmed/enroute/in_service`（done/cancelled は「完了/取消済みの予約は変更できません」）。
  - 新ホテルを引く（`is_blocked=true` なら「このホテルは受け入れ停止中です」）。
  - **交通費を再解決**: `newFee = hotel.transport_fee ?? area.transport_fee ?? 0`（新ホテルの `area_id` を使う。ホテルに area_id が無ければ予約の既存 area_id を維持）。
  - 更新: `hotel_id`、`area_id`（新ホテルに area_id があればそれに追従）、`transport_fee = newFee`、`total_amount = total_amount - oldFee + newFee`（**差分のみ。他の金額は触らない**）、`version+1`、`updated_at`。
  - 返り値: `{ oldFee, newFee, newTotal, areaChanged: boolean }`（UI で「¥2,000→¥4,000」を出す）。
  - `audit_logs` に before/after（hotel_id・transport_fee・total_amount）を追記。`revalidatePath('/admin/dispatch-board','/admin/reservation-list','/admin/annai')`。
- テスト（`ztest-therapist-change.test.ts` のフィクスチャ手法に倣う）: 交通費の違うホテルへ変更すると `transport_fee` と `total_amount` が差分更新される／`area_id` が追従する／blocked ホテルは拒否／done は拒否。4〜5ケース。

- [ ] **Step 1:** 失敗テスト → **Step 2:** FAIL 確認 → **Step 3:** 実装 → **Step 4:** 緑。
- [ ] **Step 5:** `git add src/lib/reservations/hotel-actions.ts tests/integration/ztest-hotel-change.test.ts && git commit -m "feat(reservation): ホテル変更（交通費を自動再計算して差分更新）"`

---

## Task 3: 共通 HotelInfoPanel（情報表示＋変更）

**Files:** Create `src/app/(admin)/admin/_components/HotelInfoPanel.tsx`

client component。props: `{ reservationId: string; currentHotelId: string | null; currentHotelName: string | null; hotels: HotelLookupRow[]; onChanged: () => void; onToast: (t: string, kind: 'ok'|'error') => void }`。

- **情報表示**（現在のホテルが分かる場合）: 実績バッジ（〇/△/✖）・**迎え方**（entryNote）・**カードキー要**・**ゲストチャージ**・**入店注意/履歴**（accessNote）・住所・**地図リンク**・**交通費**（実効額。個別かエリア既定かを小さく注記）。
- **ホテル変更**: 検索できるプルダウン（名前で絞り込み・blocked は選べない/グレー）＋「変更」ボタン → `changeReservationHotel`。成功時トーストに「交通費 ¥2,000→¥4,000（合計 ¥27,000）」のように**変化を明示**し `onChanged()`。
- ホテル未設定（自宅等）の場合は「ホテル未設定」＋変更プルダウンのみ表示。
- 管理側日本語直書き可・`any` 禁止・金額は整数。

- [ ] **Step 1:** 実装＋`pnpm typecheck && pnpm lint`。
- [ ] **Step 2:** `git add "src/app/(admin)/admin/_components/HotelInfoPanel.tsx" && git commit -m "feat(admin): ホテル情報＋変更の共通パネル"`

---

## Task 4: 配車ボードに組み込み

**Files:** Modify `src/app/(admin)/admin/dispatch-board/{page.tsx,DispatchBoardClient.tsx}`

- page.tsx: `listHotelsLookup()` を取得し client へ（`hotels` prop）。`DispatchBoardItem` に `hotelId` が無ければ `queries.ts` の select に `r.hotel_id` を追加して返す（**additive**・既存フィールドは不変）。
- DispatchBoardClient: 派遣先セルのホテル名を**クリック可能**にし、クリックでその行の下に `HotelInfoPanel` を展開（開閉トグル・同時に1行だけ開く）。変更成功時は `getDispatchBoard` を再取得。
- 既存挙動（脚D&D・状態・終了・アラート・退勤送り・案内表タブ埋込 syncUrl）は保持。

- [ ] **Step 1:** 実装 → **Step 2:** `pnpm typecheck && pnpm lint && pnpm build`。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/dispatch-board" src/lib/dispatch-board/queries.ts && git commit -m "feat(dispatch-board): 派遣先クリックでホテル情報＋変更を展開"`

---

## Task 5: 予約一覧にも組み込み

**Files:** Modify `src/app/(admin)/admin/reservation-list/{page.tsx,ReservationListClient.tsx}`

- `ReservationListItem` に `hotelId: string | null` を追加（list-actions の select に `r.hotel_id`）。
- page.tsx で `listHotelsLookup()` を取得 → client へ。派遣先セルをクリックで `HotelInfoPanel` を展開。変更成功で一覧再取得。
- 既存挙動（担当変更・詳細モーダル・OP追加・部屋番号・D&D・ソート）は保持。

- [ ] **Step 1:** 実装 → **Step 2:** `pnpm typecheck && pnpm lint && pnpm build`。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/reservation-list" src/lib/reservations/list-actions.ts && git commit -m "feat(reservation-list): 派遣先クリックでホテル情報＋変更を展開"`

---

## Task 6: 検証
- [ ] Run `pnpm test` → 全 PASS（新規 ztest-hotel-change 込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: ホテル情報の展開＝Task1/3/4/5、ホテル変更＋**交通費自動更新**＝Task2（発注者確定）。配車ボードと予約一覧の両方。
- 金銭: 交通費の差分のみ `total_amount` に反映（コース/OP/指名は不変）。解決規則は 0039 と同一（ホテル個別 > エリア既定）。audit_logs 記録。
- 安全: blocked ホテルは選ばせない。done/cancelled は変更不可。ホテル変更は占有時間を変えないので exclusion への影響なし。
- 型整合: `HotelLookupRow.transportFee/areaTransportFee`（Task1）→ Task3 UI。`changeReservationHotel`（Task2）→ Task3。`hotelId`（Task4/5 の additive 追加）→ HotelInfoPanel の `currentHotelId`。
