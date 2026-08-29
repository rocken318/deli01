# フェーズ12 設計ノート: 電話受付・不成立ログ・電話確認

## 基本方針

- 受付が電話をつなぎながら片手で入力できること（Tab キーだけで最後まで）
- 合計金額は常に画面上部に固定表示（電話口で即答）
- 空き枠は公開側とまったく同じエンジンを使う（受付専用ロジックなし）
- 不成立は必ず記録する（どこで注文を落としているかを数字に）

## 電話確認ゲート（phone_confirmed_at）

- Web 予約: 受付が電話で本人確認後、`phone_confirmed_at` をセット
- 電話注文: 保存時に自動で `phone_confirmed_at = now()` をセット
- `canGenerateDispatch()` は `phone_confirmed_at` が null なら false
- 打診テキスト（住所なし）は確認前でも生成可（`canGenerateInquiry()`）

## 不成立ログ（lost_orders）

- 理由は必須（time / area / nomination / price / other）
- Zod で reason フィールドを required にし、未選択では保存できない
- 電話番号・エリアは任意（電話をつなぎながらの入力）

## 架電記録（call_logs）

- 架電のたびに result（confirmed / no_answer / other）と note を記録
- `confirmPhoneCall()` Server Action が予約の `phone_confirmed_at` 更新と call_log 挿入をトランザクションで一括処理

## QA チェックリスト（spec 15章より）

- [ ] `canGenerateDispatch`: phone_confirmed_at=null → false
- [ ] `canGenerateDispatch`: confirmed + phone_confirmed_at設定済み → true
- [ ] 電話注文保存時に phone_confirmed_at が自動でセットされる
- [ ] 不成立ログ: reason 未選択では保存できない（Zod エラー）
- [ ] lost_orders, call_logs の RLS が有効（pg_class 走査テストが通る）
- [ ] 枠外予約: overrideReason なしで can('override_slot') = false
- [ ] Tab キーでフォームを最後まで操作できる
