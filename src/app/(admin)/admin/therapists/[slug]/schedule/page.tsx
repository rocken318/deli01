/**
 * セラピスト当日状況ページ /admin/therapists/[slug]/schedule（読み取り専用・force-dynamic）
 * ?date=YYYY-MM-DD で日付指定。省略時は Asia/Tokyo の今日。
 * spec 12-2 準拠。管理側なので日本語直書き可。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDevSession } from '@/lib/cms/dev-session';
import { toActor } from '@/lib/auth/session';
import { can } from '@/domain/auth';
import { getClient } from '@/lib/db-client';
import { withUser } from '@/lib/auth/with-user';
import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz';
import { addDays } from 'date-fns';
import { TherapistScheduleNav } from './TherapistScheduleNav';

export const dynamic = 'force-dynamic';

const TZ = 'Asia/Tokyo';
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  return { title: `当日状況: ${slug} — 管理` };
}

interface ShiftRow {
  id: string;
  start_at: Date;
  end_at: Date;
  base_start_name: string | null;
  base_end_name: string | null;
  is_day_off: boolean;
  note: string | null;
  area_names: string | null;
}

interface ReservationRow {
  id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  customer_name: string | null;
  course_name: string;
  area_name: string;
}

interface TherapistBasic {
  slug: string;
  display_name: string | null;
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

/** 前日 / 翌日の ISO 文字列を返す */
function offsetDate(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00+09:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default async function TherapistSchedulePage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const sp = await searchParams;

  const todayISO = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
  const dateISO =
    typeof sp.date === 'string' && DATE_RE.test(sp.date) ? sp.date : todayISO;

  const session = await getDevSession();
  if (!session || !can(toActor(session), 'manage_reservations')) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/therapists"
            className="text-sm text-adm-muted hover:text-adm-primary transition-colors"
          >
            ← セラピスト一覧
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

  // セラピスト存在確認
  let therapist: TherapistBasic | undefined;
  let shift: ShiftRow | undefined;
  let reservations: ReservationRow[] = [];

  try {
    const result = await withUser(sql, session, async (tx) => {
      // セラピスト基本情報
      const therapistRows = await tx<{ slug: string; display_name: string | null }[]>`
        select t.slug,
               er.published->>'name' as display_name
        from therapists t
        left join entity_records er
               on er.entity = 'therapist' and er.slug = t.slug
        where t.slug = ${slug}
        limit 1
      `;
      if (therapistRows.length === 0) return null;

      const therapistRow = therapistRows[0];

      // 当日シフト（左結合で exists だけ確認。無ければ null）
      const shiftRows = await tx<ShiftRow[]>`
        select
          s.id,
          s.start_at,
          s.end_at,
          bs.name  as base_start_name,
          be.name  as base_end_name,
          s.is_day_off,
          s.note,
          (select string_agg(ar.name, '、' order by ar.name)
             from shift_areas sa
             join areas ar on ar.id = sa.area_id
            where sa.shift_id = s.id)  as area_names
        from shifts s
        left join bases bs on bs.id = s.base_start_id
        left join bases be on be.id = s.base_end_id
        join therapists t on t.id = s.therapist_id
        where t.slug = ${slug}
          and s.work_date = ${dateISO}::date
        limit 1
      `;

      // 当日予約一覧
      const dayStart = fromZonedTime(`${dateISO}T00:00:00`, TZ);
      const dayEnd = addDays(dayStart, 1);

      const reservationRows = await tx<ReservationRow[]>`
        select
          r.id,
          r.status::text,
          r.start_at,
          r.end_at,
          c.name   as customer_name,
          co.name  as course_name,
          ar.name  as area_name
        from reservations r
        join therapists t on t.id = r.therapist_id
        join courses co on co.id = r.course_id
        join areas ar on ar.id = r.area_id
        left join customers c on c.id = r.customer_id
        where t.slug = ${slug}
          and r.start_at >= ${dayStart}
          and r.start_at < ${dayEnd}
          and r.status not in ('held', 'cancelled', 'noshow')
        order by r.start_at asc
      `;

      return {
        therapist: therapistRow,
        shift: shiftRows[0],
        reservations: reservationRows,
      };
    });

    if (!result) {
      notFound();
    }

    therapist = result.therapist;
    shift = result.shift;
    reservations = result.reservations;
  } catch {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/therapists"
            className="text-sm text-adm-muted hover:text-adm-primary transition-colors"
          >
            ← セラピスト一覧
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

  if (!therapist) {
    notFound();
  }

  const displayName = therapist.display_name ?? slug;
  const prevDate = offsetDate(dateISO, -1);
  const nextDate = offsetDate(dateISO, 1);

  return (
    <div className="space-y-4">
      {/* ヘッダ */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link
          href="/admin/therapists"
          className="text-sm text-adm-muted hover:text-adm-primary transition-colors"
        >
          ← セラピスト一覧
        </Link>
        <span className="text-adm-border">/</span>
        <Link
          href={`/admin/therapists/${slug}`}
          className="text-sm text-adm-muted hover:text-adm-primary transition-colors"
        >
          {displayName}
        </Link>
        <span className="text-adm-border">/</span>
        <h1 className="text-lg font-semibold text-adm-text">当日状況</h1>
      </div>

      {/* 日付ナビ（クライアントコンポーネント） */}
      <TherapistScheduleNav
        slug={slug}
        dateISO={dateISO}
        todayISO={todayISO}
        prevDate={prevDate}
        nextDate={nextDate}
      />

      {/* シフト情報 */}
      <SectionBox title={`シフト（${dateISO}）`}>
        {!shift ? (
          <p className="text-sm text-adm-muted py-2">この日は出勤予定なし</p>
        ) : shift.is_day_off ? (
          <p className="text-sm py-2" style={{ color: '#B4453C' }}>
            当日休み
            {shift.note && <span className="ml-2 text-adm-muted">（{shift.note}）</span>}
          </p>
        ) : (
          <dl>
            <div className="flex gap-3 py-1.5 border-b border-adm-border">
              <dt className="w-36 shrink-0 text-sm text-adm-muted">出勤時間</dt>
              <dd className="text-sm text-adm-text">
                {formatInTimeZone(shift.start_at, TZ, 'HH:mm')} — {formatInTimeZone(shift.end_at, TZ, 'HH:mm')}
              </dd>
            </div>
            {shift.base_start_name && (
              <div className="flex gap-3 py-1.5 border-b border-adm-border">
                <dt className="w-36 shrink-0 text-sm text-adm-muted">待機拠点（開始）</dt>
                <dd className="text-sm text-adm-text">{shift.base_start_name}</dd>
              </div>
            )}
            {shift.base_end_name && (
              <div className="flex gap-3 py-1.5 border-b border-adm-border">
                <dt className="w-36 shrink-0 text-sm text-adm-muted">待機拠点（終了）</dt>
                <dd className="text-sm text-adm-text">{shift.base_end_name}</dd>
              </div>
            )}
            {shift.area_names && (
              <div className="flex gap-3 py-1.5 border-b border-adm-border">
                <dt className="w-36 shrink-0 text-sm text-adm-muted">対応エリア</dt>
                <dd className="text-sm text-adm-text">{shift.area_names}</dd>
              </div>
            )}
            {shift.note && (
              <div className="flex gap-3 py-1.5">
                <dt className="w-36 shrink-0 text-sm text-adm-muted">備考</dt>
                <dd className="text-sm text-adm-text">{shift.note}</dd>
              </div>
            )}
          </dl>
        )}
      </SectionBox>

      {/* 予約一覧 */}
      <SectionBox title={`当日の予約（${reservations.length}件）`}>
        {reservations.length === 0 ? (
          <p className="text-sm text-adm-muted py-2">この日の予約はありません</p>
        ) : (
          <div className="divide-y divide-adm-border">
            {reservations.map((r) => (
              <div key={r.id} className="py-3 flex items-start justify-between gap-4 flex-wrap">
                <div className="text-sm">
                  <div className="font-semibold text-adm-text">
                    {formatInTimeZone(r.start_at, TZ, 'HH:mm')} — {formatInTimeZone(r.end_at, TZ, 'HH:mm')}
                  </div>
                  <div className="mt-0.5 text-adm-muted">
                    {r.customer_name ?? '（顧客未設定）'}
                    <span className="mx-2 text-adm-border">·</span>
                    {r.course_name}
                    <span className="mx-2 text-adm-border">·</span>
                    {r.area_name}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className="text-xs px-2 py-0.5 border"
                    style={{ borderRadius: '4px', borderColor: '#DFE3DE', color: '#6B7280' }}
                  >
                    {STATUS_LABEL[r.status] ?? r.status}
                  </span>
                  <Link
                    href={`/admin/reservations/${r.id}`}
                    className="text-xs text-adm-primary hover:underline"
                  >
                    詳細 →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionBox>
    </div>
  );
}
