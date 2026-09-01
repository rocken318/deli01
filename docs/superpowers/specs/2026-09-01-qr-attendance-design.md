# QR出退勤（attendances）設計 — 2026-09-01

deli01 フェーズ「D. QR出退勤」。spec 3-5（出退勤＝実績）を土台に、事務所QRの本人スキャンで出勤/退勤を打刻する。予定（`shifts`）と実績（`attendances`）は混ぜない。

## 目的 / 非目的

**目的**: 「今日は誰が実際に動けるのか」を実績で可視化し、予定精度・安全確認に使う。事務所に物理的に居る証明としての打刻。
**非目的（spec 3-5・16章）**: 労働時間の管理・遅刻への制裁・時間で縛る運用は作らない。位置情報は扱わない（本設計では取得しない）。業務委託者の労働者性に配慮。

## 方式の決定（ブレスト結果）

- **QR方式 = 事務所QRを本人がスキャン（方式A）**。事務所のタブレット/モニタにQRを表示し、セラピストが自分のログイン済みスマホで読む→打刻。なりすまし・遠隔打刻・スクショ使い回しを防ぐ。
- **トークン = 自動更新の短命署名トークン（DB非保存・ステートレス）**。
- **位置情報 = 取得しない**。
- **予定が無くても打刻可**（当日飛び込み出勤に対応）。
- **出勤/退勤は自動判定**（1 work_date につき 出勤/退勤 の1組）。

## データモデル

新規 `migrations/0020_attendances.sql`：

```
attendances (
  id            uuid pk default gen_random_uuid(),
  therapist_id  uuid not null references therapists(id),
  work_date     date not null,              -- JST の稼働日
  clock_in_at   timestamptz,
  clock_out_at  timestamptz,
  status        attendance_status not null default 'working', -- working | done
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (therapist_id, work_date)           -- 1人1日1行（冪等 upsert）
)
```

- `clock_in_location/out_location` 列は**作らない**（位置情報を扱わない方針）。将来同意ベースで足す場合も別マイグレーション。
- `attendance_status` enum = `working`（出勤打刻済・未退勤）/ `done`（退勤済）。予定外や遅刻は**保存フラグにせず**、`shifts` との差分計算で導出（実績は事実だけ持つ）。
- work_date は Asia/Tokyo の暦日で確定（日跨ぎ勤務も出勤時刻の JST 日付で1行）。

## トークン設計（ステートレス署名）

- 秘密鍵 `ATTENDANCE_QR_SECRET`（env）。未設定でもビルドは通す（[[feedback-no-over-configuration]] 遵守）。未設定時はキオスク画面が「未設定」を表示し発行しない。
- トークン = `base64url(payload).base64url(HMAC-SHA256(secret, payload))`。payload = `{ iat, exp }`（exp = iat + 窓, 既定 60秒）。
- 純関数 `src/domain/attendance/token.ts`：`signToken(secret, nowMs, ttlMs)` / `verifyToken(secret, token, nowMs) -> { ok: true } | { ok: false, reason: 'expired'|'bad_signature'|'malformed' }`。
- キオスク画面は 45秒ごとにサーバから新トークンを取得し QR を再描画（exp 60秒＝重複窓で切れ目なし）。
- リプレイ：窓が短いため実害小。加えて打刻書き込みが**冪等**（同一 work_date は upsert・二度押しで二重打刻しない）ため、同一トークンの多重利用でも状態は壊れない。

## 画面とフロー

1. **キオスク `/admin/attendance/kiosk`**（owner/admin）：QRを大きく自動更新表示。QRの中身 = `<origin>/mypage/punch?t=<token>`。事務所常設端末で開きっぱなしにする。
2. **打刻 `/mypage/punch?t=…`**（セラピスト＝ログイン必須）：
   - サーバでトークン検証（失効/改ざん/未設定は拒否画面）。
   - 本人の当日 `attendances` を引き、**状態に応じて1ボタンだけ**表示：行なし→「出勤」／`working`→「退勤」／`done`→「本日は退勤済み」。
   - 押下 = サーバアクション `punchAttendance`：トークン再検証 → 本人 therapist_id 解決 → work_date 算出 → upsert（出勤は clock_in_at セット＝status working／退勤は clock_out_at セット＝status done）。冪等。
3. **管理差分 `/admin/attendance`（当日）**（owner/admin）：全セラピストの **予定vs実績**。列＝予定(shift 有無・予定時刻)／実績(出勤/退勤時刻)／導出ラベル（未打刻・遅刻・早退・予定外出勤・退勤済）。可視化のみ。

## 純関数（ドメイン）

`src/domain/attendance/`：
- `token.ts`：signToken / verifyToken（上記）。
- `state.ts`：`nextPunchAction(attendance | null) -> 'clock_in' | 'clock_out' | 'none'`（自動判定）。`deriveAttendanceState(attendance | null) -> '未出勤'|'出勤中(待機/接客は別)'|'退勤済'`（案内表が消費する土台）。
- `diff.ts`：`compareShiftVsAttendance(shift | null, attendance | null, now) -> { label: '未打刻'|'遅刻'|'早退'|'予定外出勤'|'退勤済'|'予定通り', lateMin?, earlyMin? }`。閾値は素直に（予定開始超過で遅刻、予定終了前の退勤で早退）。制裁用途でない旨コメント。

## RLS / 権限

- `attendances`：`enable/force row level security`。
  - owner/admin：全操作。
  - therapist：自分の行のみ select。書き込みは**サーバアクション経由のみ**（トークン検証＋本人 therapist_id 一致）。shifts の自己ポリシー流儀（`shifts_self_*`）に合わせ、self insert/update は guard 付きで列を絞る。
  - reception：当日実績の select 可（配車/受付が「誰が動けるか」を見るため）。
- `app_runtime` への grant を RLS 必須セット（docs/auth-rls.md §4）通りに付与。

## 案内表との接続（今回は土台のみ）

- QR出勤＝案内表の「出勤確定/待機中」、QR退勤＝「上がり」に対応。今回は `attendances` テーブル＋`deriveAttendanceState()` まで提供し、板の表示は中断中の案内表フェーズ（[[deli01-annai-reception-brainstorm]]）が消費する。
- 当日欠勤は案内表側で扱う（`shifts.is_day_off`）。attendances は「実際に打刻された事実」だけを持つ。

## テスト（spec 15章 / 実Postgres統合）

- token：署名の往復、期限切れ拒否、改ざん拒否、malformed 拒否、秘密鍵未設定時の挙動。
- state：nextPunchAction の全分岐（なし→出勤／working→退勤／done→none）。
- diff：未打刻・遅刻・早退・予定外・退勤済・予定通りの各ケース。
- 統合：punchAttendance の冪等性（二度押しで二重打刻しない）、RLS（他人の行を読めない・書けない・サーバアクション経由のみ書ける）、work_date の JST 確定。
- grep 検査：直書き日本語（公開側なし＝管理/マイページはOKだが用語は既存流儀に合わせる）、any 不使用、金額に小数なし（本機能は金額を扱わない）。

## スコープ / 依存 / 段取り

- **1 PR = 1フェーズ**。含む：`0020_attendances.sql`＋seed 追記（任意）＋`src/domain/attendance/*`＋サーバアクション＋`/admin/attendance/kiosk`・`/mypage/punch`・`/admin/attendance` の3画面＋テスト。
- **本番稼働の依存（停止条件②）**：本方式は本人ログイン必須。本番キャストアカウントは Supabase bootstrap 待ち（既知の発注者ステップ）。開発は `?as=slug` で検証、本番打刻は発行後。
- env：`ATTENDANCE_QR_SECRET`（Vercel設定は発注者ステップ・未設定でもビルド可）。
- 検証：`pnpm typecheck && pnpm lint && pnpm test && pnpm build` を通す。Supabase 同期（0020）は発注者依頼（[[deli01-vercel-deploy]]）。

## 非採用の代替案（記録）

- トークンをDBテーブル（nonce）で管理：リプレイ完全防止に寄るが、インフラ増＋窓が短い本方式で実害小のため不採用。
- 位置情報での在所確認：契約上の論点＋spec 注意のため不採用。
- 打刻を /mypage 内セクションに同居：QR前提の入口を明確にするため専用 `/mypage/punch` に分離。
