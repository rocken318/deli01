# キャスト自入力の出勤登録（B）設計 — 2026-09-01

deli01 バックログ B の残り＝**キャスト本人が自分の出勤予定を登録する**（管理側一括は PR #59 で完了済み）。spec 3-3。自律進行（[[feedback-autonomy-proceed]]）で実施。

## 目的 / スコープ
- セラピスト本人が /mypage から **自分の出勤予定**（単日＋月/週一括）を登録・更新できる。
- 対応エリアは **全アクティブエリアを自動付与**（案内表の「基本全員同じ案内エリア」方針 [[deli01-annai-reception-brainstorm]] に合わせ、キャストにエリア選択UIは出さない）。管理は従来どおり /admin/shifts で個別調整可。
- 金銭・個人情報なし。PII/法令の停止条件に該当しない。

## 非目的
- キャストによる他人の出勤編集（RLSで拒否）。
- キャストの base（出発/帰着拠点）や max_bookings 設定（管理のみ）。単純化のため time のみ。
- 当日欠勤は既存の self_update（is_day_off ワンタップ）で対応済み＝本件では触らない。

## データ / RLS（新規 `migrations/0021_shift_self_insert.sql`）
既存 0007 は shifts に `shifts_self_select`/`shifts_self_update`（当日欠勤用）を持つが **self insert が無い**。shift_areas は therapist=select のみ。以下を追加：
- `shifts_self_insert`: `with check` therapist_id = 本人（app_users 経由）。
- `shift_areas_self_insert`: `with check` = 自分の shift の行のみ。
- `shift_areas_self_delete`: `using` = 自分の shift の行のみ（エリア全置換のため）。
grant は 0007 で付与済み（app_runtime に shifts/shift_areas 全操作）。

## ロジック（純関数は既存を再利用）
- `enumerateShiftDates`（src/domain/shifts/dates.ts・上限100日）と `shiftInstants`（src/domain/availability/shift.ts）をそのまま使う。
- Core `src/lib/shifts/self-queries.ts`：`upsertMyShiftCore(tx, therapistId, workDate, startAt, endAt): Promise<{ id: string; areaCount: number }>`
  - shifts を upsert（own・base/max は触らず、既存値を保持。is_day_off=false）。
  - shift_areas を全置換＝`delete` → `is_active=true` の全エリアを `insert`。
  - RLS 下（therapist セッション）で実行。他人 therapist_id は insert with-check で拒否。

## Server Actions（`src/lib/shifts/self-actions.ts` "use server"）
- `saveMyShiftAction({ date, start, end, asSlug? })`：単日。
- `saveMyShiftsBulkAction({ rangeStart, rangeEnd, weekdays, start, end, asSlug? })`：期間×曜日。
- 本人 therapist_id は **session（getTherapistDevSession）から解決**。クライアントの id は受け取らない。Zod 検証（date=YYYY-MM-DD, HH:MM, weekdays 0-6）。`revalidatePath('/mypage')`。
- upsert 前に既存 shift の base/max を SELECT して保持（time だけ更新、他列を消さない）。

## UI（`src/app/(therapist)/mypage/ShiftSelfRegister.tsx` client＋/mypage に差し込み）
- 「出勤を登録」セクション。タブ or 折りたたみで【単日】【月・週まとめて】。
- 単日：日付＋開始/終了時刻。一括：期間＋曜日チェック＋開始/終了時刻。送信で action 呼び出し→成功/エラー3状態表示。
- 既存 ScheduleSection（A1）の下に配置。PC/管理は無改変。

## テスト（実Postgres統合）
- `upsertMyShiftCore`：本人セッションで単日 upsert→shifts 1行＋shift_areas=全アクティブ数。再実行で冪等（time 更新・重複エリアなし）。
- RLS：他人 therapist_id への upsert は throw（insert with-check 拒否）。他人の shift_areas は insert/delete できない。
- bulk：enumerateShiftDates で期間×曜日が展開され複数日 upsert。
- 既存 enumerateShiftDates unit は流用。

## スコープ / 検証
- 1 PR。migration＋core＋actions＋UI＋統合テスト。`typecheck && lint && test && build` 緑。reviewer(fable) → 指摘反映 → CI緑 → squash マージ。
- 本番 Neon への 0021 適用は発注者ステップ（[[deli01-vercel-deploy]]）。
- 依存：本番キャストログインは Supabase bootstrap 待ち（開発は ?as=aoi/ren）。
