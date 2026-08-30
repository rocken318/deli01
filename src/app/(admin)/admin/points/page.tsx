/**
 * ポイント管理ページ（フェーズ16 / spec 9章）。
 * - 電話番号または顧客名で残高照会・台帳履歴表示
 * - 手動付与（earnPoints）
 * - 失効30日前一覧（listExpiringPoints）
 * - 指名NG管理（addNgPair / removeNgPair）
 * spec 12-2 デザイントークン準拠
 */

import type { Metadata } from 'next';
import { listExpiringPoints } from '@/lib/points/actions';
import { listNgPairs } from '@/lib/nomination/actions';
import { getDevSession } from '@/lib/cms/dev-session';
import { getClient } from '@/lib/db-client';
import { PointsClient } from './PointsClient';

export const metadata: Metadata = { title: 'ポイント管理' };

// DB を毎リクエスト読むためビルド時プリレンダしない（判断ログ #14 と同方針）
export const dynamic = 'force-dynamic';

interface TherapistOption {
  id: string;
  name: string;
}

interface CustomerOption {
  id: string;
  name: string;
  phone: string;
}

async function loadPageData() {
  const session = await getDevSession();
  if (!session) {
    return { error: '認証が必要です' };
  }

  const sql = getClient();

  // セラピスト一覧（NG登録フォーム用）。名前は entity_records.published->>'name'（therapists に name 列は無い）
  const therapistRows = await sql<{ id: string; name: string }[]>`
    select t.id, coalesce(er.published->>'name', t.slug) as name
    from therapists t
    left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
    where t.status = 'active'
    order by t.display_order asc
  `;

  // 顧客一覧（NG登録フォーム用 / 最近200件）
  const customerRows = await sql<{ id: string; name: string; phone: string }[]>`
    select id, name, phone from customers
    order by created_at desc
    limit 200
  `.catch(() => [] as { id: string; name: string; phone: string }[]);

  const [expiringResult, ngResult] = await Promise.all([
    listExpiringPoints(30),
    listNgPairs(),
  ]);

  return {
    therapists: therapistRows as TherapistOption[],
    customers: customerRows as CustomerOption[],
    expiringLots: expiringResult.ok ? (expiringResult.data ?? []) : [],
    expiringError: expiringResult.ok ? null : (expiringResult.error ?? null),
    ngPairs: ngResult.ok ? (ngResult.data ?? []) : [],
    ngError: ngResult.ok ? null : (ngResult.error ?? null),
  };
}

export default async function PointsPage() {
  const data = await loadPageData();

  if ('error' in data) {
    return (
      <div className="bg-red-50 border border-adm-warn text-adm-warn rounded p-4 text-sm">
        {data.error}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-adm-text">ポイント管理</h1>
      <PointsClient
        initialExpiringLots={data.expiringLots}
        expiringError={data.expiringError}
        initialNgPairs={data.ngPairs}
        ngError={data.ngError}
        therapists={data.therapists}
        customers={data.customers}
      />
    </div>
  );
}
