import type { Metadata } from 'next';
import { getDispatchTemplates } from '@/lib/dispatch/actions';
import { getDevSession } from '@/lib/cms/dev-session';
import MessageTemplatesClient from './MessageTemplatesClient';

export const metadata: Metadata = {
  title: '送信テンプレート',
};

export const dynamic = 'force-dynamic';

/**
 * 送信テンプレート編集ページ（Server Component）。
 * 打診用・確定用の2テンプレートを編集できる。
 * owner/admin のみ編集可（reception は閲覧のみ）。
 */
export default async function MessageTemplatesPage() {
  const session = await getDevSession();
  const isEditor = session?.role === 'owner' || session?.role === 'admin';

  const result = await getDispatchTemplates();
  const templates = result.ok ? result.data : undefined;
  const error = result.ok ? undefined : result.error;

  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-1">送信テンプレート</h1>
      <p className="text-sm text-adm-muted mb-6">
        セラピストへの送信テキスト（LINE 等）のテンプレートを管理します。
        {!isEditor && (
          <span className="ml-2 inline-block px-2 py-0.5 text-xs rounded bg-yellow-50 border border-yellow-200 text-yellow-700">
            閲覧のみ（編集は owner/admin）
          </span>
        )}
      </p>

      {error && (
        <div className="bg-red-50 border border-adm-warning text-red-800 rounded p-3 text-sm mb-4">
          {error}
        </div>
      )}

      {!templates && !error && (
        <div className="text-sm text-adm-muted py-8 text-center">
          テンプレートを読み込み中…
        </div>
      )}

      {templates && (
        <MessageTemplatesClient
          initialTemplates={templates}
          isEditor={isEditor}
        />
      )}
    </div>
  );
}
