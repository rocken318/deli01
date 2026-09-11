import type { Metadata } from 'next';
import { getDispatchBoard } from '@/lib/dispatch-board/actions';
import { getDispatchLegs, getSendHomeLegs } from '@/lib/dispatch-board/leg-actions';
import { listActiveDriversForDate } from '@/lib/drivers/shift-actions';
import { listHotelsLookup } from '@/lib/hotels/hotel-lookup-actions';
import { toZonedTime, format } from 'date-fns-tz';
import DispatchBoardClient from './DispatchBoardClient';

export const metadata: Metadata = {
  title: '配車ボード',
};

export const dynamic = 'force-dynamic';

const APP_TZ = 'Asia/Tokyo';

export default async function DispatchBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const todayISO = format(toZonedTime(new Date(), APP_TZ), 'yyyy-MM-dd');
  const dateISO =
    typeof params.date === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(params.date)
      ? params.date
      : todayISO;

  const [result, legsResult, driversResult, sendHomeResult, hotelsResult] = await Promise.all([
    getDispatchBoard(dateISO),
    getDispatchLegs(dateISO, true),
    listActiveDriversForDate(dateISO),
    getSendHomeLegs(dateISO, true),
    listHotelsLookup(),
  ]);
  const items = result.ok ? (result.data ?? []) : [];
  const legs = legsResult.ok ? (legsResult.data ?? []) : [];
  const activeDrivers = driversResult.ok ? (driversResult.data ?? []) : [];
  const sendHomeLegs = sendHomeResult.ok ? (sendHomeResult.data ?? []) : [];
  const hotels = hotelsResult.ok ? (hotelsResult.data ?? []) : [];
  const error = result.ok ? undefined : result.error;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-adm-text">配車ボード</h1>
      </div>
      <p className="text-sm text-adm-muted mb-6">
        当日のセラピストごとの移動・施術ブロックを確認し、ステータスを進めます。
        右のドライバーを送り車/帰り車セルへドラッグして割り当てます。
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm mb-4">
          {error}
        </div>
      )}

      <DispatchBoardClient
        initialItems={items}
        initialDate={dateISO}
        todayISO={todayISO}
        initialLegs={legs}
        initialActiveDrivers={activeDrivers}
        initialSendHomeLegs={sendHomeLegs}
        hotels={hotels}
      />
    </div>
  );
}
