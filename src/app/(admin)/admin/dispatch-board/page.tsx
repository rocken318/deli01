import type { Metadata } from 'next';
import { getDispatchBoard } from '@/lib/dispatch-board/actions';
import { toZonedTime, format } from 'date-fns-tz';
import DispatchBoardClient from './DispatchBoardClient';

export const metadata: Metadata = {
  title: '配車ボード',
};

export const dynamic = 'force-dynamic';

const APP_TZ = 'Asia/Tokyo';

/**
 * 配車ボード（Server Component / spec 7-1・7-3）。
 * - URL クエリ ?date=YYYY-MM-DD で日付指定。省略時は Asia/Tokyo の今日。
 * - getDispatchBoard で当日の全セラピスト予約を取得し DispatchBoardClient へ渡す。
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

  const result = await getDispatchBoard(dateISO);
  const items = result.ok ? (result.data ?? []) : [];
  const error = result.ok ? undefined : result.error;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-adm-text">配車ボード</h1>
      </div>
      <p className="text-sm text-adm-muted mb-6">
        当日のセラピストごとの移動・施術ブロックを確認し、ステータスを進めます。
        退出未記録の予約はアラートで表示されます。
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
      />
    </div>
  );
}
