# 認証・役割・RLS・監査ログ 設計ノート（フェーズ1）

対象: `migrations/0001_auth.sql` / `src/domain/auth/` / `src/lib/auth/` / `tests/integration/auth-rls.test.ts`
根拠: spec 13-3（住所の閲覧制御）・15章（権限テスト）・7-2/8-1（枠外予約）・3-5/8-3（監査対象）・17章（テストアカウント）

## 1. GUC × SET ROLE × RLS の仕組み

アプリは 1 つの接続ユーザーで DB に入るため、「誰の操作か」を **GUC（セッション変数）** で、
「特権を落とす」を **SET ROLE** で表現する。業務クエリは必ず `withUser()` 経由で流す。

```
withUser(sql, session, fn)
  └ BEGIN
      set_config('app.current_user_id', session.userId, true)  -- 誰が
      set_config('app.current_role',    session.role,   true)  -- どのロールで
      set_config('role', 'app_runtime', true)                  -- 特権のない DB ロールに降格
      fn(tx)   -- この中のクエリすべてに RLS が効く
    COMMIT / ROLLBACK（set_config(..., true) = SET LOCAL なので自動で元に戻る）
```

- ポリシーは `app_current_user_id()` / `app_current_role()`（`current_setting('app.current_user_id', true)` の薄いラッパ）を参照する
- **fail-closed**: GUC 未設定（withUser を忘れたコードパス）ではヘルパが null を返し、ポリシー不成立＝デフォルト拒否。アプリのバグは「見えすぎる」ではなく「見えない」側に倒れる
- `app_runtime`（nologin）への降格が**唯一の実効防壁**である理由: 接続ユーザー `postgres` は **どちらも `rolbypassrls=true`**（ローカル docker は superuser、Supabase は非 superuser だが `BYPASSRLS` 属性を持つ）。BYPASSRLS ロールは `enable`/`force` に関わらず RLS を素通りするので、**素の接続では本番でも RLS は効かない**（migrate / seed / 保守クエリが通るのはこのため）。RLS が実際に効くのは `SET LOCAL ROLE app_runtime` で **BYPASSRLS を持たない `app_runtime` に降格した後だけ**。したがって業務クエリは必ず `withUser()`（＝降格）経由で流す
- `force row level security` の役割: `app_runtime` が万一いずれかのテーブルの owner になっても owner 特権で素通りさせない保険。BYPASSRLS ロールは force でも止められないため、防御の本線はあくまで降格である（force はその補強）
- 事実確認（2026-08-29）: `select current_user, rolsuper, rolbypassrls` → ローカル `{postgres, t, t}` / Supabase `{postgres, f, t}`。この結論は BYPASSRLS の有無に依存し、両環境で本線（降格）は有効

## 2. 現在のポリシー一覧（0001）

| テーブル | select | insert/update/delete |
|---|---|---|
| site_settings / terminology / field_definitions | 全員（公開側が参照） | owner/admin のみ |
| app_users | owner/admin/reception は全行、therapist は自分の行のみ | insert/update: owner/admin、delete: owner のみ |
| audit_logs | owner/admin のみ | insert のみ可（actor は自分か null。詐称不可）。update/delete は**ポリシーなし＋grant なし**で不可（追記専用） |

監査ログの表現規約: 住所閲覧 = `action='view', entity='address', entity_id=addresses.id`、
CSV 出力 = `action='export'`、枠外予約 = `action='override'` + `after.reason`、
送信ログ（8-3）は専用の `dispatch_logs` をフェーズ13で追加（audit_logs と併用）。

## 3. アプリ層の二重防御（src/domain/auth）

RLS と同じルールを純粋関数 `can(actor, capability, ctx)` でも表現する。
UI の出し分け・Server Action の事前チェックはこちら、最後の砦は RLS。

- `view_customer_address`: owner/admin/reception は常に可（ただし閲覧のたびに audit_logs へ記録するのは呼び出し側の義務）。therapist は担当予約かつ開始 180 分前（`ADDRESS_VISIBLE_BEFORE_MIN`）から
- `view_payout`: owner/admin と本人のみ。reception は不可
- `override_slot`: owner/admin/reception のみ、かつ理由（非空）必須
- `export_csv` / `manage_users` / `manage_cms` / `manage_payouts` / `view_audit_logs`: owner/admin のみ
- 文脈つき capability に ctx が無い呼び出しは常に false（fail-closed）

## 4. 将来テーブルへの拡張方針（spec 15章）

- **addresses**: therapist の select ポリシーを「担当予約が存在し、かつ `now() >= start_at - interval '180 minutes'`」の exists で表現（domain 層の 180 分と同じ定数。マイグレーション時に値を site_settings 化するか要検討）
- **payouts / payout_lines**: therapist は `therapist_id = 自分` の行のみ select。締め済みは update/delete ポリシーを張らず逆仕訳のみ
- **reservations / customers**: therapist は担当予約のみ。顧客の電話番号は 7-3 に従いセラピストへ出さない（ビューで列を落とす）
- **新テーブルを足すときの必須セット**: `enable row level security` + `force row level security` + ポリシー + `app_runtime` への grant（audit/台帳系は update/delete を grant しない）。張り忘れは統合テスト「public の全テーブルで RLS が有効」が落として検出する
- Supabase Auth live 配線: `src/lib/auth/supabase.ts` の TODO 手順どおり。auth.users → app_users は `auth_user_id` で紐付け、未紐付けは未ログイン扱い（サインアップ ≠ 利用許可）

## 5. qa へのテスト観点（フェーズ1〜）

1. **RLS 実効性（実 Postgres 必須。モック不可）**: `tests/integration/auth-rls.test.ts` を土台に拡張
   - therapist セッションで他人の app_users 行が 0 件（15章の「他人の〜不可」の代理検証。addresses/payouts 追加後に本命のテストへ差し替え）
   - withUser を通らない app_runtime 接続（GUC なし）で自分の行すら見えない（fail-closed）
   - RLS 有効性の網羅チェック（pg_class 走査）が新テーブル追加後も通ること
2. **監査ログ**: 閲覧が残ること（action='view'/entity='address' の insert 経路）、actor 詐称 insert が拒否されること、admin でも update/delete できないこと（追記専用）
3. **capability（純粋関数）**: `src/domain/auth/capabilities.test.ts` を網羅拡張。境界値は「開始ちょうど 180 分前 = 可 / 181 分前 = 不可」
4. **枠外予約**: 理由なしで can が false になること。予約テーブル導入後は「理由なしで保存できない」「audit_logs に override が残る」まで通しで
5. **CSV**: export_csv が owner/admin 以外 false。実装後は API レベルでも 403 になること
6. **seed 冪等性**: `pnpm db:seed` を 2 回流して app_users が 4 行のままであること
