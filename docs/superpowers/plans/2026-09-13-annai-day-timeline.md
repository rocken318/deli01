# 案内表：1行＝1セラピストの一日タイムライン帯 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps `- [ ]`.

**Goal:** 案内表だけで電話が完結するようにする。各セラピストの**その日の残り全部**（予約→空き→予約→空き→上がり）を時間軸の帯で見せ、**各空きが何分か**を明示。空きをクリックするとその枠で予約に進める。「今は無理だけど21時なら空いてます」を一目で答えられる状態にする。

**Architecture:** 既存 `computeAvailableWindow`（次の1枠）は**壊さず**、新たに純関数 `buildDayTimeline` を追加＝占有区間を統合して**その日の全ギャップ**を返す。案内表の各行に帯コンポーネントを描画し、ギャップのクリックで既存の予約ポップ（`BookingLauncher`/`BookingPopup`）を**開始時刻つき**で開く。マイグレーション無し。

**Tech Stack:** Next.js 15 / TS / Vitest。発注者確定: **1行＝1セラピストの帯**。

---

## 前提（実装者は該当ファイルを読む）
- `src/domain/annai/window.ts`: `JobItem{ id,startAt,endAt,departAt,freeAt,totalAmount,status,reconciledAt }`、`BoardInput{ therapistId,slug,name,attendanceState,shiftStart,shiftEnd,lateManual,done,upcoming,ngNote }`、`computeAvailableWindow(row, nowMs, buffers, minBookableMin)`（占有区間 = `[departAt, max(freeAt, endAt+after+travel)]`）、`buildBoard`。**この占有区間の作り方をそのまま再利用する**。
- `src/app/(admin)/admin/annai/page.tsx`: `listAnnaiBoardCore` → `buildBoard` → `Row` を描画。`DEFAULT_BUFFERS`・`minBookableMin` の組み立てあり。`JobCard` が左（done）／右（upcoming）に予約カードを出している。
- 予約作成: `src/app/(admin)/admin/annai/{BookingLauncher.tsx,BookingPopup.tsx}` ＋ `booking-actions.ts` の `getAnnaiBookingSlots(slug, dateISO, ...)`（**エンジンの実枠**を返す）。**枠は必ずエンジン由来を使う**（勝手な時刻で予約を作らない）。
- 営業日: 案内表は `opDay`（06:00 境界の営業日）で時刻表示している。既存の `hmMs`/`hm` ヘルパを使う。

## File Structure
- Modify `src/domain/annai/window.ts`（`buildDayTimeline` 追加）＋ `window.test.ts`（テスト追加）
- Create `src/app/(admin)/admin/annai/DayTimeline.tsx`（client・帯 UI）
- Modify `src/app/(admin)/admin/annai/page.tsx`（各行に帯を差し込む）
- Modify `src/app/(admin)/admin/annai/BookingLauncher.tsx`（開始時刻を初期選択できるように・任意 prop）

---

## Task 1: 全ギャップを返す純関数（TDD）

**Files:** Modify `src/domain/annai/window.ts`, `src/domain/annai/window.test.ts`

追加する型と関数:

```ts
export type TimelineSegmentKind = "job" | "gap" | "off";
export interface TimelineSegment {
  kind: TimelineSegmentKind;
  startMs: number;
  endMs: number;
  minutes: number;
  /** kind==='job' のとき元の予約 */
  job?: JobItem;
  /** kind==='gap' のとき、最短コースが入らない短い隙間なら true */
  tooShort?: boolean;
  /** kind==='gap' のとき、現在時刻より前に始まる（＝今すぐ案内できる）なら true */
  isNow?: boolean;
}
/**
 * その日の帯（予約→空き→予約→…）を返す純関数。
 * 範囲は [max(now, shiftStart+travel), shiftEnd]。占有区間は computeAvailableWindow と同じ定義。
 * 重なる予約は統合してひとつの job セグメントにまとめる（表示が壊れないように）。
 */
export function buildDayTimeline(
  row: BoardInput,
  nowMs: number,
  buffers?: { afterBufferMin: number; travelMin: number },
  minBookableMin?: number,
): TimelineSegment[];
```

仕様:
- `attendanceState==='done'`（上がり）→ 空配列。
- `attendanceState==='off'` かつ `shiftStart` なし → 空配列。
- 範囲の開始 = working なら `max(nowMs, shiftStart+travel)`（shiftStart 無ければ nowMs）／off なら `shiftStart+travel`。範囲の終了 = `shiftEnd`（無ければ最後の占有の終わり）。
- 占有区間は `[departAt, max(freeAt, endAt + (after+travel)*60000)]`（既存と同じ）。**開始順にソートし、重なりは統合**。
- 範囲内で、占有と占有の間（および範囲開始〜最初の占有、最後の占有〜範囲終了）を `gap` として出す。**0分以下の gap は出さない**。
- `gap.tooShort = minBookableMin>0 && minutes < minBookableMin`。`gap.isNow = startMs <= nowMs`。
- `job` セグメントは範囲外にはみ出す分をクリップして返す（開始前の done は含めない＝範囲開始より前に終わった予約は出さない）。

テスト（`window.test.ts` に追加。既存テストは壊さない）:
- 予約2件＋シフト → `job,gap,job,gap` の並びと各 `minutes` が正しい
- 予約なし → `gap` 1本（範囲まるごと）
- 上がり（done）→ 空配列
- 短い隙間に `tooShort=true` が付く
- 今より前に始まる gap は `isNow=true`
- 重なる予約は1つの job に統合される

- [ ] **Step 1:** 失敗テスト → **Step 2:** FAIL → **Step 3:** 実装 → **Step 4:** 緑（既存12件も緑のまま）。
- [ ] **Step 5:** `git add src/domain/annai/window.ts src/domain/annai/window.test.ts && git commit -m "feat(annai): 一日の全ギャップを返す buildDayTimeline（純関数）"`

---

## Task 2: 帯 UI コンポーネント

**Files:** Create `src/app/(admin)/admin/annai/DayTimeline.tsx`

client component。props: `{ segments: TimelineSegment[]; opDay: string; onPickGap: (startMs: number) => void }`。

- 横並びの帯（flex・各セグメントの幅は `minutes` に比例＝`flexGrow`。最小幅を確保して潰れないように）。横スクロール可。
- **job セグメント**: 灰〜橙系。中身は `HH:MM–HH:MM` と金額（`totalAmount`）。`title` に詳細。クリックで予約詳細へ（`/admin/reservations/[id]`）。
- **gap セグメント**: 緑系（`tooShort` は橙＋「短」）。中身は **`HH:MM〜HH:MM（N分）`**。`isNow` の gap は「今すぐ〜」と表示。**クリックで `onPickGap(startMs)`**。
- 空配列なら「上がり/未出勤」の淡い表示。
- 管理側日本語直書き可・`any` 禁止。色は spec 12-2（明色・主色 #3F7A6B・注意 #C98A2B・警告 #B4453C）。

- [ ] **Step 1:** 実装 → **Step 2:** `pnpm typecheck && pnpm lint`。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/annai/DayTimeline.tsx" && git commit -m "feat(annai): 一日タイムライン帯コンポーネント"`

---

## Task 3: 案内表に組み込み＋空きクリックで予約

**Files:** Modify `src/app/(admin)/admin/annai/page.tsx`, `src/app/(admin)/admin/annai/BookingLauncher.tsx`

- `page.tsx`: 各行で `buildDayTimeline(r, nowMs, DEFAULT_BUFFERS, minBookableMin)` を計算し、`Row` の中（中央の「次案内可能」カードの下）に `DayTimeline` を描画。**既存の左右 JobCard・中央カード・状態チップ・NGバッジは残す**（帯は追加情報）。
- **空きクリック → 予約**: `BookingLauncher` に任意 prop `initialStartMs?: number` を追加し、`BookingPopup` を開いた時に **`getAnnaiBookingSlots` が返す実枠のうち、その時刻に最も近い枠を初期選択**する（枠が無ければ通常どおり一覧から選ばせる）。**エンジンの枠以外では予約を作らない**（安全のため必須）。
- `DayTimeline.onPickGap(startMs)` から Launcher を開く配線（行ごとの state）。
- 既存挙動（予約ポップの作成・OP絞込・車要否・計上ボタン等）は不変。

- [ ] **Step 1:** 実装 → **Step 2:** `pnpm typecheck && pnpm lint && pnpm build`＋`pnpm test -- tests/integration/annai-board-p1a.test.ts` 緑。
- [ ] **Step 3:** `git add "src/app/(admin)/admin/annai" && git commit -m "feat(annai): 行に一日タイムラインを表示し空きクリックで予約"`

---

## Task 4: 検証
- [ ] Run `pnpm test` → 全 PASS（window.test.ts 追加分込み・既存非破壊）。
- [ ] Run `pnpm typecheck && pnpm lint && pnpm build` → すべて成功。

---

## Self-Review
- Spec coverage: 「今だけでなく次・その次・間の空きも案内表で分かる」＝Task1-3（発注者確定の帯形式）。空き時間の長さを明示＝gap の `minutes`。
- 安全: 予約作成は**必ずエンジンの実枠**（`getAnnaiBookingSlots`）経由。帯の gap は「そこに枠がありそう」の目安で、実枠が無ければ作らせない。
- 非破壊: `computeAvailableWindow`/`buildBoard` は変更しない（`buildDayTimeline` を追加するだけ）。案内表の既存要素も残す。
- 型整合: `TimelineSegment`/`buildDayTimeline`（Task1）→ `DayTimeline`（Task2）→ `page.tsx`（Task3）。`initialStartMs`（Task3）は任意 prop で既存呼び出しを壊さない。
