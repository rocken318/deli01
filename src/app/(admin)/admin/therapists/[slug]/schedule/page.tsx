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
import {
  getTherapistMonthOverview,
  type TherapistMonthOverview,
} from '@/lib/admin/therapist-overview';

export const dynamic = 'force-dynamic';

const TZ = 'Asia/Tokyo';
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const YEN = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string; month?: string }>;
}

/** YYYY-MM を delta ヶ月ずらす */
function shiftMonth(monthISO: string, delta: number): string {
  const [y, m] = monthISO.split('-').map(Number);
  const d = new Date(y!, m! - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 月グリッド（先頭の曜日オフセット込み） */
function monthGrid(monthISO: string): (string | null)[] {
  const [y, m] = monthISO.split('-').map(Number);
  const first = new Date(y!, m! - 1, 1);
  const daysInMonth = new Date(y!, m!, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < first.getDay(); i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push(`${monthISO}-${String(d).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** 月間出勤カレンダー＋今月の稼ぎ＋導線（管理側の overview） */
function MonthOverview({
  slug,
  overview,
  selectedDate,
  todayISO,
}: {
  slug: string;
  overview: TherapistMonthOverview;
  selectedDate: string;
  todayISO: string;
}) {
  const dayMap = new Map(overview.days.map((d) => [d.dateISO, d]));
  const cells = monthGrid(overview.monthISO);
  const prevMonth = shiftMonth(overview.monthISO, -1);
  const nextMonth = shiftMonth(overview.monthISO, 1);
  const dayHref = (dateISO: string) =>
    `/admin/therapists/${slug}/schedule?month=${overview.monthISO}&date=${dateISO}`;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* カレンダー（2/3） */}
      <SectionBox title={`出勤カレンダー`}>
        <div className="mb-3 flex items-center justify-between">
          <Link
            href={`/admin/therapists/${slug}/schedule?month=${prevMonth}`}
            className="border border-adm-border px-3 py-1 text-sm text-adm-text hover:border-adm-primary hover:text-adm-primary"
            style={{ borderRadius: '4px' }}
          >
            ← 前月
          </Link>
          <span className="text-sm font-semibold text-adm-text">
            {overview.monthISO.replace('-', '年')}月（出勤{overview.shiftDays}日 / 予約{overview.reservationTotal}件）
          </span>
          <Link
            href={`/admin/therapists/${slug}/schedule?month=${nextMonth}`}
            className="border border-adm-border px-3 py-1 text-sm text-adm-text hover:border-adm-primary hover:text-adm-primary"
            style={{ borderRadius: '4px' }}
          >
            翌月 →
          </Link>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {WEEKDAYS.map((w, i) => (
            <div
              key={w}
              className="py-1 text-xs"
              style={{ color: i === 0 ? '#B4453C' : i === 6 ? '#3F7A6B' : '#6B7776' }}
            >
              {w}
            </div>
          ))}
          {cells.map((dateISO, idx) => {
            if (!dateISO) return <div key={`e${idx}`} />;
            const d = dayMap.get(dateISO);
            const dayNum = Number(dateISO.slice(-2));
            const isToday = dateISO === todayISO;
            const isSelected = dateISO === selectedDate;
            return (
              <Link
                key={dateISO}
                href={dayHref(dateISO)}
                className="relative flex aspect-square flex-col items-center justify-center"
                style={{
                  border: isSelected
                    ? '2px solid #3F7A6B'
                    : isToday
                      ? '1px solid #3F7A6B'
                      : '1px solid #ECEFEC',
                  background: d?.isDayOff ? '#F1F1F1' : d?.hasShift ? '#EAF3EF' : '#FFFFFF',
                  borderRadius: '4px',
                }}
              >
                <span className="text-sm text-adm-text">{dayNum}</span>
                {d?.hasShift && !d.isDayOff && (
                  <span className="text-[9px]" style={{ color: '#3F7A6B' }}>{d.startHHmm}</span>
                )}
                {d?.isDayOff && <span className="text-[9px] text-adm-muted">休</span>}
                {d && d.reservationCount > 0 && (
                  <span
                    className="absolute right-0.5 top-0.5 rounded-full px-1 text-[9px] leading-none"
                    style={{ background: '#3F7A6B', color: '#FFFFFF' }}
                  >
                    {d.reservationCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
        <div className="mt-3 flex gap-3 text-xs text-adm-muted">
          <span><span style={{ color: '#3F7A6B' }}>■</span> 出勤</span>
          <span><span style={{ color: '#C7C7C7' }}>■</span> 休み</span>
          <span><span style={{ color: '#3F7A6B' }}>●</span> 数字=予約件数</span>
        </div>
      </SectionBox>

      {/* 今月の稼ぎ＋導線（1/3） */}
      <SectionBox title="今月の稼ぎ（確定バック）">
        <p className="mb-3 text-2xl font-semibold text-adm-text tabular-nums">
          {YEN(overview.earnings.monthTotal)}
        </p>
        {overview.earnings.byCategory.length === 0 ? (
          <p className="text-sm text-adm-muted">今月の確定バックはまだありません。</p>
        ) : (
          <dl className="divide-y divide-adm-border">
            {overview.earnings.byCategory.map((c) => (
              <div key={c.category} className="flex justify-between py-1.5 text-sm">
                <dt className="text-adm-muted">{c.label}</dt>
                <dd className="tabular-nums text-adm-text">{YEN(c.amount)}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-4 flex flex-col gap-2">
          <Link
            href="/admin/payouts"
            className="bg-adm-primary px-3 py-2 text-center text-sm font-medium text-white hover:opacity-90"
            style={{ borderRadius: '4px' }}
          >
            報酬・締め処理へ
          </Link>
          <Link
            href={`/admin/therapists/${slug}`}
            className="border border-adm-border px-3 py-2 text-center text-sm text-adm-text hover:border-adm-primary hover:text-adm-primary"
            style={{ borderRadius: '4px' }}
          >
            プロフィール・登録情報を編集
          </Link>
          <Link
            href="/admin/analytics"
            className="border border-adm-border px-3 py-2 text-center text-sm text-adm-text hover:border-adm-primary hover:text-adm-primary"
            style={{ borderRadius: '4px' }}
          >
            セラピスト別 集計へ
          </Link>
        </div>
      </SectionBox>
    </div>
  );
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
  const monthISO =
    typeof sp.month === 'string' && MONTH_RE.test(sp.month) ? sp.month : dateISO.slice(0, 7);

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

  // 月間 overview（出勤カレンダー + 今月の稼ぎ）。失敗しても当日ビューは出す。
  const overviewResult = await getTherapistMonthOverview({ slug, monthISO });
  const overview = overviewResult.kind === 'ok' ? overviewResult.data : null;

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
        <h1 className="text-lg font-semibold text-adm-text">出勤・予約・稼ぎ</h1>
      </div>

      {/* 月間 overview（出勤カレンダー + 今月の稼ぎ + 導線） */}
      {overview && (
        <MonthOverview
          slug={slug}
          overview={overview}
          selectedDate={dateISO}
          todayISO={todayISO}
        />
      )}

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
