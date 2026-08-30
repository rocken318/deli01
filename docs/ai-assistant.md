# CMS内AIアシスタント — できること/できないこと/承認フロー

## できること

| 機能 | 操作種別 | 説明 |
|------|----------|------|
| 下書き生成 | generate | プロフィール文/キャッチコピー/お知らせ/FAQ回答/SEOタイトル/ディスクリプションの下書きを生成 |
| リライト | rewrite | 既存テキストをより自然な表現に書き直す |
| 禁止語言い換え | banned_word_suggest | 禁止語を検出し、法に触れない表現に言い換え案を提案 |
| 用語統一 | terminology_suggest | 用語辞書（terminology テーブル）に従って表記ゆれを統一 |
| 構造変更提案 | structure_change | ページブロック構成の変更案を提案（承認後に draft のみ適用） |

## できないこと（安全ゲート）

- **AIが直接公開することはできません。** 承認してもドラフトへの反映だけです。公開は別途「公開」操作が必要です。
- **published（公開中データ）は絶対に触りません。** AIの出力は draft にのみ反映されます。
- **構造変更は差分プレビュー→承認を経てから適用されます。** 承認前は draft_blocks を変更しません。
- AIが承認/却下を自分で行うことはできません。

## 承認フロー

```
runAiAssist → ai_actions (status=proposed)
                                ↓
                  owner/admin が提案を確認
                        ↓               ↓
               approveAiAction    rejectAiAction
               (status=approved)  (status=rejected)
                     ↓
              draft のみ更新
              ※ published は変わらない
                     ↓
              別途「公開」操作が必要
```

## 権限

| 操作 | owner | admin | reception |
|------|-------|-------|-----------|
| AI依頼（runAiAssist） | ○ | ○ | ○ |
| 承認（approveAiAction） | ○ | ○ | × |
| 却下（rejectAiAction） | ○ | ○ | × |
| 履歴閲覧（listAiActions） | ○ | ○ | ○ |

## 環境設定

- `ANTHROPIC_API_KEY` を Vercel の環境変数に設定してください（本番/プレビュー環境）
- ローカル開発では未設定のままで動作します（AI依頼は `failed` として記録されます）
- ビルドは `ANTHROPIC_API_KEY` なしでも必ず通ります

## 禁止語の二重防御

1. AI呼び出し前: `checkBannedWords` で入力テキストを確認（呼び出し側の責任）
2. AI出力後: 生成されたテキストにも `checkBannedWords` を適用
3. 警告として `detectedBannedWords` を返します（ブロックではなく警告）

spec 19章 / 受入条件 L1124-L1126
