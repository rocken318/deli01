'use client';

import { useState, useTransition } from 'react';
import {
  updateDispatchTemplate,
  getDispatchTemplates,
} from '@/lib/dispatch/actions';
import type { DispatchTemplates } from '@/lib/dispatch/actions';
import {
  DISPATCH_VAR_KEYS,
  buildDispatchMessage,
  INQUIRY_FORBIDDEN_KEYS,
} from '@/domain/dispatch';
import type { DispatchVarKey } from '@/domain/dispatch';

interface Props {
  initialTemplates: DispatchTemplates;
  isEditor: boolean;
}

/** ダミー vars（プレビュー表示用） */
const DUMMY_VARS: Record<DispatchVarKey, string> = {
  日時: '9/3(水) 13:00',
  出発目安: '12:35',
  セラピスト: '田中アリス',
  コース: '60分コース',
  オプション: 'アロマオイル',
  場所: '東京都渋谷区〇〇1-2-3',
  部屋番号: '305号室',
  顧客名: '山田太郎',
  電話番号: '09012345678',
  お好み: '強め希望',
  合計金額: '¥12,000',
  バック額: '¥3,000',
  移動手段: '車',
  エリア: '渋谷エリア',
};

type KindType = 'inquiry' | 'confirmed';

interface TemplateFormState {
  name: string;
  body: string;
}

/**
 * 送信テンプレート編集クライアントコンポーネント。
 * - 打診用・確定用の2フォームを縦に並べる。
 * - 差し込み変数チップ一覧を表示。クリックでカーソル位置に挿入。
 * - 打診用には「住所・電話番号は自動除去される」旨の注意書き。
 * - 保存後にダミー vars でプレビューを生成して表示。
 */
export default function MessageTemplatesClient({ initialTemplates, isEditor }: Props) {
  const [templates, setTemplates] = useState<DispatchTemplates>(initialTemplates);
  const [forms, setForms] = useState<Record<KindType, TemplateFormState>>({
    inquiry: { name: initialTemplates.inquiry.name, body: initialTemplates.inquiry.body },
    confirmed: { name: initialTemplates.confirmed.name, body: initialTemplates.confirmed.body },
  });
  const [previews, setPreviews] = useState<Record<KindType, string | null>>({
    inquiry: null,
    confirmed: null,
  });
  const [saveErrors, setSaveErrors] = useState<Record<KindType, string | null>>({
    inquiry: null,
    confirmed: null,
  });
  const [saveSuccess, setSaveSuccess] = useState<Record<KindType, boolean>>({
    inquiry: false,
    confirmed: false,
  });
  const [isPending, startTransition] = useTransition();

  const handleBodyChange = (kind: KindType, value: string) => {
    setForms((prev) => ({ ...prev, [kind]: { ...prev[kind], body: value } }));
  };

  const handleNameChange = (kind: KindType, value: string) => {
    setForms((prev) => ({ ...prev, [kind]: { ...prev[kind], name: value } }));
  };

  /** テキストエリアへの差し込み変数挿入 */
  const insertVar = (kind: KindType, key: DispatchVarKey) => {
    const token = `{{${key}}}`;
    setForms((prev) => ({
      ...prev,
      [kind]: { ...prev[kind], body: prev[kind].body + token },
    }));
  };

  /** プレビュー生成（ダミー vars） */
  const generatePreview = (kind: KindType) => {
    const preview = buildDispatchMessage({
      kind,
      template: forms[kind].body,
      vars: DUMMY_VARS,
    });
    setPreviews((prev) => ({ ...prev, [kind]: preview }));
  };

  const handleSave = (kind: KindType) => {
    setSaveErrors((prev) => ({ ...prev, [kind]: null }));
    setSaveSuccess((prev) => ({ ...prev, [kind]: false }));

    startTransition(async () => {
      const result = await updateDispatchTemplate(kind, forms[kind].body, forms[kind].name);
      if (result.ok) {
        setSaveSuccess((prev) => ({ ...prev, [kind]: true }));
        // テンプレートをリロードして最新の body を取得
        const refreshed = await getDispatchTemplates();
        if (refreshed.ok && refreshed.data) {
          setTemplates(refreshed.data);
        }
        // プレビューも再生成
        generatePreview(kind);
      } else {
        setSaveErrors((prev) => ({ ...prev, [kind]: result.error ?? '保存に失敗しました' }));
      }
    });
  };

  const kindLabels: Record<KindType, string> = {
    inquiry: '打診用テンプレート',
    confirmed: '確定用テンプレート',
  };

  const isInquiryForbidden = (key: DispatchVarKey) =>
    (INQUIRY_FORBIDDEN_KEYS as readonly string[]).includes(key);

  return (
    <div className="space-y-10">
      {/* 差し込み変数一覧（全体共通） */}
      <section className="bg-adm-surface border border-adm-border rounded p-4">
        <p className="text-sm font-medium text-adm-text mb-2">使用できる差し込み変数</p>
        <div className="flex flex-wrap gap-2">
          {DISPATCH_VAR_KEYS.map((key) => (
            <span
              key={key}
              className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border ${
                isInquiryForbidden(key)
                  ? 'bg-orange-50 border-orange-200 text-orange-700'
                  : 'bg-adm-bg border-adm-border text-adm-text'
              }`}
              title={isInquiryForbidden(key) ? '打診用には出力されません（個人情報）' : undefined}
            >
              {`{{${key}}}`}
              {isInquiryForbidden(key) && <span className="text-orange-500">*</span>}
            </span>
          ))}
        </div>
        <p className="text-xs text-adm-muted mt-2">
          <span className="text-orange-600">*</span> のついた変数は打診用テンプレートから自動的に除去されます（個人情報保護）。
        </p>
      </section>

      {/* 打診用・確定用フォーム */}
      {(['inquiry', 'confirmed'] as KindType[]).map((kind) => (
        <section key={kind} className="bg-adm-surface border border-adm-border rounded p-6">
          <h2 className="text-base font-semibold text-adm-text mb-1">{kindLabels[kind]}</h2>

          {/* 打診用の注意書き（spec 8-3 の緊張説明） */}
          {kind === 'inquiry' && (
            <div className="bg-orange-50 border border-orange-200 rounded p-3 text-sm text-orange-800 mb-4">
              <strong>注意:</strong>{' '}
              住所・電話番号・顧客名・部屋番号・お好みは打診用に出力されません（自動除去）。
              テンプレートに記載しても受取人には届きません。
              打診段階では「エリア・時間・コース・バック額」のみを送るよう設計されています（spec 8-3）。
            </div>
          )}

          {saveErrors[kind] && (
            <div className="bg-red-50 border border-adm-warning text-red-800 rounded p-2 text-xs mb-3">
              {saveErrors[kind]}
            </div>
          )}
          {saveSuccess[kind] && (
            <div className="bg-green-50 border border-green-200 text-green-800 rounded p-2 text-xs mb-3">
              保存しました
            </div>
          )}

          <div className="space-y-4">
            {/* テンプレート名 */}
            <div>
              <label className="block text-sm font-medium text-adm-text mb-1">
                テンプレート名
              </label>
              <input
                type="text"
                value={forms[kind].name}
                onChange={(e) => handleNameChange(kind, e.target.value)}
                disabled={!isEditor || isPending}
                className="w-full border border-adm-border rounded px-3 py-2 text-sm bg-adm-surface text-adm-text focus:outline-none focus:ring-1 focus:ring-adm-primary disabled:bg-adm-bg disabled:text-adm-muted"
                style={{ borderRadius: '4px' }}
              />
            </div>

            {/* 本文 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-adm-text">テンプレート本文</label>
                <div className="flex flex-wrap gap-1">
                  {DISPATCH_VAR_KEYS.filter(
                    (key) => kind === 'confirmed' || !isInquiryForbidden(key),
                  ).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => insertVar(kind, key)}
                      disabled={!isEditor || isPending}
                      className="px-1.5 py-0.5 text-xs bg-adm-bg border border-adm-border rounded hover:bg-adm-primary/10 disabled:opacity-40 transition-colors"
                      style={{ borderRadius: '4px' }}
                      title={`{{${key}}} を末尾に追加`}
                    >
                      {key}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                value={forms[kind].body}
                onChange={(e) => handleBodyChange(kind, e.target.value)}
                disabled={!isEditor || isPending}
                rows={8}
                className="w-full border border-adm-border rounded px-3 py-2 text-sm font-mono bg-adm-surface text-adm-text focus:outline-none focus:ring-1 focus:ring-adm-primary disabled:bg-adm-bg disabled:text-adm-muted resize-y"
                style={{ borderRadius: '4px' }}
                placeholder={
                  kind === 'inquiry'
                    ? '例: 【打診】{{日時}}／{{エリア}}／{{コース}}／バック{{バック額}}'
                    : '例: 【確定】{{日時}} {{出発目安}}出発\n担当: {{セラピスト}}\n場所: {{場所}} {{部屋番号}}\nTEL: {{電話番号}}'
                }
              />
              <p className="text-xs text-adm-muted mt-1">
                現在の文字数: {forms[kind].body.length}文字
              </p>
            </div>

            {/* 操作ボタン */}
            {isEditor && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleSave(kind)}
                  disabled={isPending || forms[kind].body.trim().length === 0}
                  className="px-4 py-2 bg-adm-primary text-white text-sm rounded disabled:opacity-50 hover:opacity-90 transition-opacity"
                  style={{ borderRadius: '4px' }}
                >
                  {isPending ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  onClick={() => generatePreview(kind)}
                  disabled={isPending}
                  className="px-4 py-2 border border-adm-border text-adm-text text-sm rounded hover:bg-adm-bg disabled:opacity-50 transition-colors"
                  style={{ borderRadius: '4px' }}
                >
                  プレビュー（ダミー）
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setForms((prev) => ({
                      ...prev,
                      [kind]: {
                        name: templates[kind].name,
                        body: templates[kind].body,
                      },
                    }));
                    setPreviews((prev) => ({ ...prev, [kind]: null }));
                    setSaveSuccess((prev) => ({ ...prev, [kind]: false }));
                    setSaveErrors((prev) => ({ ...prev, [kind]: null }));
                  }}
                  disabled={isPending}
                  className="px-3 py-2 text-sm text-adm-muted hover:text-adm-text disabled:opacity-50 transition-colors"
                >
                  リセット
                </button>
              </div>
            )}

            {/* プレビュー表示 */}
            {previews[kind] !== null && (
              <div>
                <p className="text-xs font-medium text-adm-muted mb-1">
                  プレビュー（ダミーデータ使用）
                  {kind === 'inquiry' && (
                    <span className="ml-2 text-orange-600">
                      ※打診用のため個人情報は表示されません
                    </span>
                  )}
                </p>
                <pre className="bg-adm-bg border border-adm-border rounded p-3 text-sm whitespace-pre-wrap font-mono text-adm-text leading-relaxed">
                  {previews[kind]}
                </pre>
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
