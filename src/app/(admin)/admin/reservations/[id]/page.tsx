/**
 * 予約詳細ページ /admin/reservations/[id]（読み取り専用・force-dynamic）
 * spec 12-2 準拠。管理側なので日本語直書き可。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDevSession } from '@/lib/cms/dev-session';
import { toActor } from '@/lib/auth/session';
import { can } from '@/domain/auth';
import { getClient } from '@/lib/db-client';
import { withUser } from '@/lib/auth/with-user';
import { formatInTimeZone } from 'date-fns-tz';

export const dynamic = 'force-dynamic';

const TZ = 'Asia/Tokyo';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  return { title: `予約詳細: ${id.slice(0, 8)}… — 管理` };
}

interface ReservationDetail {
  id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  depart_at: Date;
  free_at: Date;
  course_name: string;
  therapist_name: string | null;
  therapist_slug: string;
  customer_name: string | null;
  customer_phone: string | null;
  area_name: string;
  address_detail: string | null;
  address_label: string | null;
  total_amount: number;
  nomination_fee: number;
  transport_fee: number;
  source: string;
  phone_confirmed_at: Date | null;
  options: string | null;
}

// ローディングスケルトン（Suspense はつかわず直レンダリング）
function SectionBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="bg-adm-surface border border-adm-border p-5"
      style={{ borderRadius: '4px' }}
    >
      <h2 className="text-xs font-semibold text-adm-muted uppercase tracking-wider mb-4 pb-3 border-b border-adm-border">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 border-b border-adm-border last:border-0">
      <dt className="w-36 shrink-0 text-sm text-adm-muted">{label}</dt>
      <dd className="text-sm text-adm-text flex-1">{children}</dd>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  held: '仮押さえ',
  confirmed: '確定',
  enroute: '移動中',
  in_service: '施術中',
  done: '完了',
  cancelled: 'キャンセル',
  noshow: '無断キャンセル',
};

const SOURCE_LABEL: Record<string, string> = {
  web: 'Web予約',
  phone: '電話受付',
};

export default async function ReservationDetailPage({ params }: PageProps) {
  const { id } = await params;

  const session = await getDevSession();
  if (!session || !can(toActor(session), 'manage_reservations')) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/reservations"
            className="text-sm text-adm-muted hover:text-adm-primary transition-colors"
          >
            ← 予約管理へ戻る
          </Link>
        </div>
        <div
          role="alert"
          className="p-4 border text-sm"
          style={{ borderColor: '#B4453C', color: '#B4453C', borderRadius: '4px' }}
        >
          この画面を表示する権限がありません。
        </div>
      </div>
    );
  }

  const sql = getClient();

  let row: ReservationDetail | undefined;
  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<ReservationDetail[]>`
        select
          r.id,
          r.status::text,
          r.start_at,
          r.end_at,
          r.depart_at,
          r.free_at,
          co.name                               as course_name,
          er.published->>'name'                 as therapist_name,
          t.slug                                as therapist_slug,
          c.name                                as customer_name,
          c.phone                               as customer_phone,
          ar.name                               as area_name,
          a.detail                              as address_detail,
          a.label                               as address_label,
          r.total_amount,
          r.nomination_fee,
          r.transport_fee,
          r.source::text,
          r.phone_confirmed_at,
          (select string_agg(o.name, '、' order by o.sort_order)
             from reservation_options ro
             join options o on o.id = ro.option_id
            where ro.reservation_id = r.id)     as options
        from reservations r
        join therapists t on t.id = r.therapist_id
        join courses co on co.id = r.course_id
        join areas ar on ar.id = r.area_id
        left join entity_records er
               on er.entity = 'therapist' and er.slug = t.slug
        left join customers c on c.id = r.customer_id
        left join addresses a on a.id = r.address_id
        where r.id = ${id}::uuid
        limit 1
      `;
    });
    row = rows[0];
  } catch {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/reservations"
            className="text-sm text-adm-muted hover:text-adm-primary transition-colors"
          >
            ← 予約管理へ戻る
          </Link>
        </div>
        <div
          role="alert"
          className="p-4 border text-sm"
          style={{ borderColor: '#B4453C', color: '#B4453C', borderRadius: '4px' }}
        >
          データの取得に失敗しました。
        </div>
      </div>
    );
  }

  if (!row) {
    notFound();
  }

  const businessDate = formatInTimeZone(row.start_at, TZ, 'yyyy-MM-dd');
  const therapistScheduleHref = `/admin/therapists/${row.therapist_slug}/schedule?date=${businessDate}`;

  return (
    <div className="space-y-4">
      {/* ヘッダ */}
      <div className="flex items-center gap-3">
        <Link
          href="/admin/reservations"
          className="text-sm text-adm-muted hover:text-adm-primary transition-colors"
        >
          ← 予約管理へ戻る
        </Link>
        <span className="text-adm-border">/</span>
        <h1 className="text-lg font-semibold text-adm-text">予約詳細</h1>
      </div>

      {/* ステータスバッジ */}
      <div className="flex items-center gap-3">
        <span
          className="inline-block px-3 py-1 text-sm font-medium border"
          style={{
            borderRadius: '4px',
            borderColor: row.status === 'cancelled' || row.status === 'noshow'
              ? '#B4453C'
              : row.status === 'done'
              ? '#DFE3DE'
              : '#3F7A6B',
            color: row.status === 'cancelled' || row.status === 'noshow'
              ? '#B4453C'
              : row.status === 'done'
              ? '#6B7280'
              : '#3F7A6B',
          }}
        >
          {STATUS_LABEL[row.status] ?? row.status}
        </span>
        <span className="text-xs text-adm-muted font-mono">{row.id}</span>
      </div>

      {/* 日時 */}
      <SectionBox title="日時">
        <dl>
          <Row label="施術開始">
            {formatInTimeZone(row.start_at, TZ, 'yyyy-MM-dd HH:mm')}
          </Row>
          <Row label="施術終了">
            {formatInTimeZone(row.end_at, TZ, 'HH:mm')}
          </Row>
          <Row label="出発（depart）">
            {formatInTimeZone(row.depart_at, TZ, 'HH:mm')}
          </Row>
          <Row label="空き（free）">
            {formatInTimeZone(row.free_at, TZ, 'HH:mm')}
          </Row>
        </dl>
      </SectionBox>

      {/* コース・オプション */}
      <SectionBox title="コース・オプション">
        <dl>
          <Row label="コース">{row.course_name}</Row>
          {row.options && (
            <Row label="オプション">{row.options}</Row>
          )}
        </dl>
      </SectionBox>

      {/* セラピスト */}
      <SectionBox title="セラピスト">
        <dl>
          <Row label="担当">
            <Link
              href={therapistScheduleHref}
              className="text-adm-primary hover:underline"
            >
              {row.therapist_name ?? row.therapist_slug}
            </Link>
          </Row>
        </dl>
      </SectionBox>

      {/* 顧客 */}
      <SectionBox title="顧客">
        <dl>
          <Row label="顧客名">{row.customer_name ?? '（未設定）'}</Row>
          <Row label="電話番号">
            {row.customer_phone ? (
              <a
                href={`tel:${row.customer_phone}`}
                className="text-adm-primary hover:underline"
              >
                {row.customer_phone}
              </a>
            ) : (
              <span className="text-adm-muted">未設定</span>
            )}
          </Row>
        </dl>
      </SectionBox>

      {/* エリア・住所 */}
      <SectionBox title="エリア・住所">
        <dl>
          <Row label="エリア">{row.area_name}</Row>
          {row.address_label && (
            <Row label="住所ラベル">{row.address_label}</Row>
          )}
          <Row label="住所詳細">
            {row.address_detail ?? <span className="text-adm-muted">未設定</span>}
          </Row>
        </dl>
      </SectionBox>

      {/* 金額 */}
      <SectionBox title="金額">
        <dl>
          <Row label="合計">
            <span className="font-semibold">
              {row.total_amount.toLocaleString('ja-JP')}円
            </span>
          </Row>
          <Row label="指名料">
            {row.nomination_fee.toLocaleString('ja-JP')}円
          </Row>
          <Row label="交通費">
            {row.transport_fee.toLocaleString('ja-JP')}円
          </Row>
        </dl>
      </SectionBox>

      {/* 受付・確認 */}
      <SectionBox title="受付・確認">
        <dl>
          <Row label="受付経路">
            {SOURCE_LABEL[row.source] ?? row.source}
          </Row>
          <Row label="電話確認">
            {row.phone_confirmed_at ? (
              <span className="text-adm-primary">
                確認済み（{formatInTimeZone(row.phone_confirmed_at, TZ, 'yyyy-MM-dd HH:mm')}）
              </span>
            ) : (
              <span className="text-adm-muted">未確認</span>
            )}
          </Row>
        </dl>
      </SectionBox>
    </div>
  );
}
