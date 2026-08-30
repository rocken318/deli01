import type { Metadata } from 'next';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { listNotifications, getNotificationTemplates, getFlashDealConfigAction } from '@/lib/notify/actions';
import NotificationsClient from './NotificationsClient';

export const metadata: Metadata = { title: '通知管理' };
export const dynamic = 'force-dynamic';

/**
 * 通知管理ページ（フェーズ20 / spec L656-660・L869）。
 * - outbox（notifications）一覧
 * - 手動トリガ: リマインド生成・週次レポート・直前割バッチ
 * - 通知テンプレ編集（notification_templates）
 * - 直前割 CMS 設定（flash_deal_config）
 *
 * cron 未配線のため dev/運用暫定として手動ボタンを提供する。
 * 3状態（空・ローディング・エラー）を実装。
 */
export default async function NotificationsPage() {
  const session = await getDevSession();
  if (!session || !can(toActor(session), 'manage_cms')) {
    return (
      <div className="bg-adm-surface border border-adm-border rounded p-6">
        <p className="text-sm text-adm-text">権限がありません。</p>
      </div>
    );
  }

  const isEditor = session.role === 'owner' || session.role === 'admin';

  const [notifResult, templateResult, flashConfigResult] = await Promise.all([
    listNotifications({ limit: 50 }),
    getNotificationTemplates(),
    getFlashDealConfigAction(),
  ]);

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-adm-text">通知管理</h1>

      <NotificationsClient
        initialNotifications={notifResult.ok ? notifResult.data ?? null : null}
        initialTemplates={templateResult.ok ? templateResult.data ?? null : null}
        initialFlashConfig={flashConfigResult.ok ? flashConfigResult.data ?? null : null}
        isEditor={isEditor}
        loadError={
          !notifResult.ok ? notifResult.error
          : !templateResult.ok ? templateResult.error
          : !flashConfigResult.ok ? flashConfigResult.error
          : undefined
        }
      />
    </div>
  );
}
