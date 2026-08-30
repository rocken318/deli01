/**
 * 集計ページ（フェーズ19 / spec 10章 L860-869・11-6）。
 * エリア別粗利（突合）・需要ヒートマップ・CSV ダウンロード。
 * 管理側なので日本語直書き可。spec 12-2 デザイントークン準拠。
 * force-dynamic: DB 読取のため毎リクエスト実行。
 */
import type { Metadata } from 'next';
import { getDevSession } from '@/lib/cms/dev-session';
import { getClient } from '@/lib/db-client';
import { AnalyticsClient } from './AnalyticsClient';

export const metadata: Metadata = { title: '集計' };
export const dynamic = 'force-dynamic';

interface AreaOption { id: string; name: string }

async function loadAreas(): Promise<AreaOption[]> {
  try {
    const session = await getDevSession();
    if (!session) return [];
    const sql = getClient();
    const rows = await sql<{ id: string; name: string }[]>`
      select id, name from areas order by name asc
    `;
    return rows as AreaOption[];
  } catch {
    return [];
  }
}

export default async function AnalyticsPage() {
  const [session, areas] = await Promise.all([
    getDevSession(),
    loadAreas(),
  ]);

  if (!session) {
    return (
      <div className="bg-red-50 border border-adm-danger text-adm-danger rounded p-4 text-sm">
        認証が必要です
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-adm-text">集計</h1>
      <AnalyticsClient areas={areas} />
    </div>
  );
}
