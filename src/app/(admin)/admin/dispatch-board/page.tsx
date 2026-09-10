import type { Metadata } from 'next';
import { getDispatchBoard } from '@/lib/dispatch-board/actions';
import { getDispatchLegs } from '@/lib/dispatch-board/leg-actions';
import { listActiveDriversForDate } from '@/lib/drivers/shift-actions';
import { toZonedTime, format } from 'date-fns-tz';
import DispatchBoardClient from './DispatchBoardClient';

export const metadata: Metadata = {
  title: '配車ボード',
};

export const dynamic = 'force-dynamic';

const APP_TZ = 'Asia/Tokyo';

/**
 * 配車ボード（Server Component / spec 7-1・7-3 / フェーズ4 再設計）。
 * - URL クエリ ?date=YYYY-MM-DD で日付指定。省略時は Asia/Tokyo の今日。
 * - getDispatchBoard（予約行）・getDispatchLegs（送り/帰り脚）・
 *   listActiveDriversForDate（右レール）を取得し DispatchBoardClient へ渡す。
 *   脚は includeFinished=true で取り、終了分の表示切替はクライアントで行う。
 */
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

  const [result, legsResult, driversResult] = await Promise.all([
    getDispatchBoard(dateISO),
    getDispatchLegs(dateISO, true),
    listActiveDriversForDate(dateISO),
  ]);
  const items = result.ok ? (result.data ?? []) : [];
  const legs = legsResult.ok ? (legsResult.data ?? []) : [];
  const activeDrivers = driversResult.ok ? (driversResult.data ?? []) : [];
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
      />
    </div>
  );
}
