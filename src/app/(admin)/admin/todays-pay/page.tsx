import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { format } from 'date-fns-tz';
import { toZonedTime } from 'date-fns-tz';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { getTodaysPay } from '@/lib/payout/todays-pay-actions';
import TodaysPayClient from './TodaysPayClient';

export const metadata: Metadata = {
  title: '当日給料',
};

export const dynamic = 'force-dynamic';

const APP_TZ = 'Asia/Tokyo';

export default async function TodaysPayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const session = await getDevSession();
  if (!session || !can(toActor(session), 'manage_reservations')) {
    redirect('/admin');
  }

  const params = await searchParams;
  const todayISO = format(toZonedTime(new Date(), APP_TZ), 'yyyy-MM-dd');
  const dateISO =
    typeof params.date === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(params.date)
      ? params.date
      : todayISO;

  const result = await getTodaysPay(dateISO);
  const rows = result.ok ? (result.data ?? []) : [];
  const error = result.ok ? undefined : result.error;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-adm-text">当日給料（日払い精算）</h1>
      </div>
      <p className="text-sm text-adm-muted mb-4">
        帰り際に当日のバックを集計して現金手渡しで精算します。支払額＝バック合計−雑費（10%）。
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm mb-4">
          {error}
        </div>
      )}

      <TodaysPayClient
        initialRows={rows}
        dateISO={dateISO}
        todayISO={todayISO}
      />
    </div>
  );
}
