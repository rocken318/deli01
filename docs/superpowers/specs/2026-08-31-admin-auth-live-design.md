# 管理側 Auth の本番 live 配線（Supabase Auth / email+パスワード）

- 日付: 2026-08-31
- 対象: 本番で `/admin/*`（会計・報酬・配車ボード・AI 等）と `/mypage`（セラピスト）を実ログインで有効化する
- 背景: v1 は全23フェーズ完了。管理側は開発スタブ認証 `ADMIN_DEV_SESSION` を本番に置いていないため、本番では全ページが「認証が必要です」になる。spec 1-2「Supabase Auth（管理側のみ）」の live 配線は v1 完成後の申し送り（(a) live 化）。

## 決定事項（発注者合意 2026-08-31）

1. **進め方**: コード先行＋発行スクリプト同梱。実装〜PR/マージは自走。本番アカウント作成は Supabase 操作（停止条件②）＝発注者ステップ。
2. **ログイン方式**: email + パスワード（`signInWithPassword`）。メール送信(SMTP)配線に依存しない。
3. **アカウント発行**: ブートストラップスクリプトのみ（ユーザー管理UIは作らない / YAGNI）。

## 全体方針

既存の継ぎ目を使う。新しい認証機構は作らない。

- `src/lib/auth/index.ts` の `getDefaultSessionProvider()` … 本番用の継ぎ目（既存）
- `src/lib/auth/supabase.ts` の `createSupabaseSessionProvider()` … スケルトン（本 spec で実装）
- `src/db/schema.ts` / `migrations/0001_auth.sql` の `app_users.auth_user_id`（unique）… Supabase `auth.users.id` 紐付け（既存）
- `src/lib/auth/with-user.ts` の `withUser()`（GUC＋`app_runtime` ロール降格）… **不変**。RLS の防御本線。

**env は遅延・寛容**（`feedback-no-over-configuration`）。Supabase env 未設定でもビルド・ローカル開発（`ADMIN_DEV_SESSION=1`）は壊れないこと。import 時に throw しない。

## コンポーネント設計

### 1. セッション解決（中核）

`src/lib/cms/dev-session.ts` の `getDevSession()` / `getTherapistDevSession()` は**関数名・約40箇所の呼び出し・テストの `vi.mock` を据え置き**、本体だけを二段化する（churn 最小・security-critical PR のリスク低減）。

```
getDevSession():
  if env.adminDevSession === "1":   // ローカル / CI
    return スタブ owner（従来どおり）
  else:                             // 本番
    return createSupabaseSessionProvider().getSession()

getTherapistDevSession(slug?):
  if env.adminDevSession === "1":
    return 従来のなりすまし解決（?as=slug 有効）
  else:
    const s = await getSession()
    return s?.role === 'therapist' ? s : null   // 本番は自分のみ。slug 無視
```

`createSupabaseSessionProvider().getSession()` の実装:

1. `@supabase/ssr` の `createServerClient`（`next/headers` の `cookies()` アダプタ）で cookie セッションを読む
2. `supabase.auth.getUser()` で `auth.users.id` を取得（無ければ `null`）
3. **特権接続**（`getClient()` の生 SQL。`withUser` を通さない。migrate/seed と同じ保守経路）で
   `select id, role, therapist_id from app_users where auth_user_id = $1 and is_active = true`
   - セッション成立前の写像ルックアップなので RLS を通さない（接続ユーザーは BYPASSRLS）。
   - 該当行が無い auth ユーザー（サインアップ ≠ 利用許可）は `null`
4. `{ userId: app_users.id, role, therapistId: therapist_id ?? undefined }` を返す

これにより各ページ/アクションは「ログイン中ユーザーの**実ロール**」を受け取る（dev の owner 固定と異なり、`can()`＋RLS が role で正しく絞る）。

### 2. ログイン / ログアウト UI

- ルート `/login`（公開。route group の外側 or 独立 group。spec 12-2 明色トークン）。
  - email + パスワードのフォーム（Server Component）→ Server Action `signIn(formData)`。
  - `signIn`: `createServerClient` → `auth.signInWithPassword({ email, password })`。成功で cookie 発行（アダプタ経由）→ `redirect(next ?? '/admin')`。**認証は全てサーバ側**（client JS の supabase 不要）。
  - 入力は Zod 検証。失敗の3状態を表示: 資格情報エラー / Supabase 未設定 / 通信失敗。
  - `next` パラメータはオープンリダイレクト防止のため**同一オリジンの相対パスのみ**許可（`/` 始まりかつ `//` でない）。
- ログアウト: Server Action `signOut` → `auth.signOut()` → `redirect('/login')`。
- `src/app/(admin)/layout.tsx` と `(therapist)/layout.tsx` に、ログイン中の表示名＋ログアウトボタンを小さく追加。dev（スタブ）時は「dev: owner」表示。

### 3. middleware（入口ゲート・UX 用。防御は多層の一段）

`src/middleware.ts` を新規追加。

- `@supabase/ssr` でリクエスト毎にトークンをリフレッシュ（`@supabase/ssr` 標準パターン）。
- `matcher`: `/admin/:path*`・`/mypage/:path*`。
- **未認証（Supabase user 無し）なら `/login?next=<path>` へリダイレクト**。
- **ゲートしない条件**（スタブ運用・ローカル・ビルドを壊さない）:
  - `env.adminDevSession === "1"`（ローカル/CI）
  - Supabase env（URL/anonKey）未設定
- `/api/*`（CTI webhook 等）・静的資産・公開ページは matcher 対象外。
- **権威判定はここではしない**。ロール・`app_users` 紐付け・`is_active` の最終判定はページ/アクションの `getSession → withUser → RLS`。middleware は cookie の有無による UX リダイレクトのみ（edge runtime で DB を引かない）。

### 4. ブートストラップ発行スクリプト

`scripts/bootstrap-auth.ts`（発注者が本番で実行）。

- `SUPABASE_SERVICE_ROLE_KEY` ＋ `NEXT_PUBLIC_SUPABASE_URL` で `supabase.auth.admin.createUser({ email, password, email_confirm: true })`。
- 対象 `app_users`（role/display_name で特定）ごとに auth ユーザーを作成 → `update app_users set auth_user_id = <new id> where id = <app_user id>`。
- **冪等**: `app_users.auth_user_id` が既にあればスキップ。同 email の auth ユーザーが既にあれば再利用（作成失敗を握って既存を引く）。
- email マッピングは CLI 引数 or JSON 設定で指定。初期パスワードは**自動生成し一度だけ標準出力**（秘匿値はコミット・ログ永続化しない）。
- 本番 Supabase を対象に発注者が service_role 実キーで実行。ローカルは keys 無しで no-op（実行前チェックで停止）。
- `docs/operations.md` に実行手順を追記。

### 5. env・依存

- 依存追加: `@supabase/ssr`・`@supabase/supabase-js`。
- `src/lib/env.ts`: 既存 `supabaseUrl`・`supabaseAnonKey` に加え `supabaseServiceRoleKey`（遅延・寛容）を追加。
- 本番 Vercel には `NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_ANON_KEY`・`SUPABASE_SERVICE_ROLE_KEY` が登録済み（値の実物性は本番ログイン検証で最終確認）。

## データフロー

```
[ブラウザ] --(/admin/*)--> [middleware] --未認証--> /login
                                |認証済 cookie
                                v
[/admin ページ] -> getDevSession() --本番--> createSupabaseSessionProvider
                                              -> auth.getUser() (cookie)
                                              -> app_users lookup (特権接続, auth_user_id)
                                              -> Session{userId, role, therapistId}
                                -> withUser(sql, session, fn)  // GUC + app_runtime 降格
                                -> RLS が role/所有で行を絞る
```

## エラーハンドリング

- Supabase 未設定（ローカル/CI/未提供）: middleware ゲート無効・`getSession` は null・`/login` は「未設定」を表示。ビルドは通る。
- 認証失敗: `/login` に資格情報エラーを表示（詳細はログに出さない）。
- 紐付け無し auth ユーザー: `getSession` が null → ページは「認証が必要です」。
- `next` オープンリダイレクト: 相対パス以外は `/admin` にフォールバック。

## テスト

- Supabase セッションプロバイダのマッピング（`auth.getUser` モック＋**実 Postgres** の `app_users` 引き）:
  - `auth_user_id` 一致 → 正しい role/therapistId
  - `is_active = false` → null
  - 未紐付け auth ユーザー → null
  - therapist の `getTherapistDevSession` 本番経路は自分のみ（slug 無視）
- `signIn` Server Action（supabase クライアントモック）: 成功で redirect / 失敗でエラー / Zod 不正入力。
- `next` サニタイズのユニットテスト（`//evil`・`https://` を拒否）。
- 既存テストは dev 経路（`ADMIN_DEV_SESSION=1` / `vi.mock`）不変で緑のまま。

## 検証（合格条件）

- `pnpm db:reset` → `typecheck` → `lint` → `test` → `build` 緑。
- grep: 管理側の日本語直書きは可 / `JSON.stringify`+`::jsonb` 0 / `any` 0 / 画像混入 0。
- ローカル: `ADMIN_DEV_SESSION=1` で `/admin` が従来どおり表示・middleware がリダイレクトしない。
- security-critical 差分 → **reviewer(fable) を通す**（`feedback-fable-sparingly`: 金銭/セキュリティは reviewer 残す）。
- PR → CI + Vercel 緑 → squash マージ → Supabase 同期（新規マイグレーションは無い見込み。あれば 5432 で適用）。

## 停止条件との関係

- 実装〜PR/マージ: 自走。
- 発注者ステップ（停止条件②）: ①anon/service_role 実キーの最終確認 ②`bootstrap-auth.ts` 実行（初期アカウント作成） ③本番 `/login`→`/admin` 実ログイン検証。

## やらないこと（スコープ外 / YAGNI）

- ユーザー管理UI（`/admin/users`）。作らない。追加は script 再実行 or Supabase 画面。
- マジックリンク / SSO / 顧客ログイン（spec で任意・ロードマップ）。
- パスワードリセットのメールフロー（SMTP 配線後の別タスク）。
- `getDevSession`/`getTherapistDevSession` の改名（misleading だが 40 ファイル＋テストモック改修はリスク。ドキュメントコメントで二段挙動を明記し、改名は将来のクリーンアップに残す）。
