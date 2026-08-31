'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  getMyMonthlySchedule,
  getMyReservations,
  getMyServiceHistory,
} from '@/lib/dispatch-board/therapist-portal-actions';

const APP_TZ = 'Asia/Tokyo';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const STATUS_LABEL: Record<string, string> = {
  confirmed: '予約確定',
  enroute: '移動中',
  in_service: '施術中',
  done: '完了',
};

interface ScheduleDay {
  dateISO: string;
  hasShift: boolean;
  isDayOff: boolean;
  startHHmm: string | null;
  endHHmm: string | null;
  reservationCount: number;
}
interface ReservationItem {
  reservationId: string;
  dateISO: string;
  startHHmm: string;
  endHHmm: string;
  status: string;
  courseName: string;
  areaName: string | null;
  hotelName: string | null;
}
interface HistoryItem {
  reservationId: string;
  dateISO: string;
  startHHmm: string;
  courseName: string;
  areaName: string | null;
  totalAmount: number;
}

type View = 'calendar' | 'reservations' | 'history';

function todayISO(): string {
  return format(toZonedTime(new Date(), APP_TZ), 'yyyy-MM-dd');
}
function thisMonth(): string {
  return format(toZonedTime(new Date(), APP_TZ), 'yyyy-MM');
}
function shiftMonth(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const d = new Date(y!, m! - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 月グリッド（先頭の曜日オフセット込み）の日付セル配列を作る。 */
function monthGrid(yearMonth: string): (string | null)[] {
  const [y, m] = yearMonth.split('-').map(Number);
  const first = new Date(y!, m! - 1, 1);
  const daysInMonth = new Date(y!, m!, 0).getDate();
  const lead = first.getDay(); // 0=Sun
  const cells: (string | null)[] = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push(`${yearMonth}-${String(d).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function ScheduleSection({ asSlug }: { asSlug?: string }) {
  const [view, setView] = useState<View>('calendar');
  const [yearMonth, setYearMonth] = useState(thisMonth());
  const [days, setDays] = useState<ScheduleDay[]>([]);
  const [reservations, setReservations] = useState<ReservationItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dayMap = useMemo(
    () => new Map(days.map((d) => [d.dateISO, d])),
    [days],
  );

  const loadCalendar = useCallback(
    async (ym: string) => {
      setLoading(true);
      setError(null);
      const res = await getMyMonthlySchedule(ym, asSlug);
      if (res.ok && res.data) setDays(res.data);
      else setError(res.error ?? '取得に失敗しました');
      setLoading(false);
    },
    [asSlug],
  );

  const loadReservations = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMyReservations(todayISO(), asSlug);
    if (res.ok && res.data) setReservations(res.data);
    else setError(res.error ?? '取得に失敗しました');
    setLoading(false);
  }, [asSlug]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMyServiceHistory(asSlug);
    if (res.ok && res.data) setHistory(res.data);
    else setError(res.error ?? '取得に失敗しました');
    setLoading(false);
  }, [asSlug]);

  useEffect(() => {
    if (view === 'calendar') void loadCalendar(yearMonth);
    else if (view === 'reservations') void loadReservations();
    else void loadHistory();
  }, [view, yearMonth, loadCalendar, loadReservations, loadHistory]);

  const cells = useMemo(() => monthGrid(yearMonth), [yearMonth]);
  const today = todayISO();

  const dayHref = (dateISO: string) => {
    const p = new URLSearchParams();
    if (asSlug) p.set('as', asSlug);
    p.set('date', dateISO);
    return `/mypage?${p.toString()}`;
  };

  return (
    <div
      className="rounded overflow-hidden"
      style={{ background: '#FFFFFF', border: '1px solid #DFE3DE', borderRadius: '4px' }}
    >
      {/* タブ */}
      <div className="flex text-sm" style={{ borderBottom: '1px solid #DFE3DE' }}>
        {(
          [
            ['calendar', '出勤カレンダー'],
            ['reservations', '予約一覧'],
            ['history', '接客履歴'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className="flex-1 py-2.5 font-medium"
            style={{
              color: view === key ? '#3F7A6B' : '#6B7776',
              borderBottom: view === key ? '2px solid #3F7A6B' : '2px solid transparent',
              background: view === key ? '#F3F7F5' : '#FFFFFF',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="p-3">
        {loading && (
          <div className="py-8 text-center text-sm" style={{ color: '#6B7776' }} aria-busy="true">
            読み込み中…
          </div>
        )}
        {!loading && error && (
          <div role="alert" className="py-4 text-center text-sm" style={{ color: '#B4453C' }}>
            {error}
          </div>
        )}

        {/* カレンダー */}
        {!loading && !error && view === 'calendar' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => setYearMonth((ym) => shiftMonth(ym, -1))}
                className="px-3 py-1 text-sm rounded"
                style={{ border: '1px solid #DFE3DE', color: '#1C2321', borderRadius: '4px' }}
              >
                ← 前月
              </button>
              <span className="text-sm font-semibold" style={{ color: '#1C2321' }}>
                {yearMonth.replace('-', '年')}月
              </span>
              <button
                type="button"
                onClick={() => setYearMonth((ym) => shiftMonth(ym, 1))}
                className="px-3 py-1 text-sm rounded"
                style={{ border: '1px solid #DFE3DE', color: '#1C2321', borderRadius: '4px' }}
              >
                翌月 →
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1 text-center">
              {WEEKDAYS.map((w, i) => (
                <div
                  key={w}
                  className="text-xs py-1"
                  style={{ color: i === 0 ? '#B4453C' : i === 6 ? '#3F7A6B' : '#6B7776' }}
                >
                  {w}
                </div>
              ))}
              {cells.map((dateISO, idx) => {
                if (!dateISO) return <div key={`e${idx}`} />;
                const d = dayMap.get(dateISO);
                const dayNum = Number(dateISO.slice(-2));
                const isToday = dateISO === today;
                const cell = (
                  <div
                    className="aspect-square rounded flex flex-col items-center justify-center relative"
                    style={{
                      border: isToday ? '2px solid #3F7A6B' : '1px solid #ECEFEC',
                      background: d?.isDayOff ? '#F1F1F1' : d?.hasShift ? '#EAF3EF' : '#FFFFFF',
                      borderRadius: '4px',
                    }}
                  >
                    <span className="text-sm" style={{ color: '#1C2321' }}>{dayNum}</span>
                    {d?.hasShift && !d.isDayOff && (
                      <span className="text-[9px]" style={{ color: '#3F7A6B' }}>
                        {d.startHHmm}
                      </span>
                    )}
                    {d?.isDayOff && (
                      <span className="text-[9px]" style={{ color: '#9A9A9A' }}>休</span>
                    )}
                    {d && d.reservationCount > 0 && (
                      <span
                        className="absolute top-0.5 right-0.5 text-[9px] leading-none px-1 py-0.5 rounded-full"
                        style={{ background: '#3F7A6B', color: '#FFFFFF' }}
                      >
                        {d.reservationCount}
                      </span>
                    )}
                  </div>
                );
                // 予約がある日は当日タイムラインへ誘導（既存 /mypage?date= を再利用）
                return d && d.reservationCount > 0 ? (
                  <a key={dateISO} href={dayHref(dateISO)} aria-label={`${dateISO} の予定`}>
                    {cell}
                  </a>
                ) : (
                  <div key={dateISO}>{cell}</div>
                );
              })}
            </div>

            <div className="mt-3 flex gap-3 text-xs" style={{ color: '#6B7776' }}>
              <span><span style={{ color: '#3F7A6B' }}>■</span> 出勤</span>
              <span><span style={{ color: '#C7C7C7' }}>■</span> 休み</span>
              <span><span style={{ color: '#3F7A6B' }}>●</span> 数字=予約件数</span>
            </div>
          </div>
        )}

        {/* 予約一覧 */}
        {!loading && !error && view === 'reservations' && (
          <div>
            {reservations.length === 0 ? (
              <p className="py-8 text-center text-sm" style={{ color: '#6B7776' }}>
                これからの予約はありません。
              </p>
            ) : (
              <ul className="space-y-2">
                {reservations.map((r) => (
                  <li
                    key={r.reservationId}
                    className="rounded p-3"
                    style={{ border: '1px solid #ECEFEC', borderRadius: '4px' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold" style={{ color: '#1C2321' }}>
                        {r.dateISO.slice(5).replace('-', '/')} {r.startHHmm}–{r.endHHmm}
                      </span>
                      <span
                        className="text-[11px] px-2 py-0.5 rounded-full"
                        style={{
                          background: r.status === 'done' ? '#ECEFEC' : '#EAF3EF',
                          color: r.status === 'done' ? '#6B7776' : '#3F7A6B',
                        }}
                      >
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </div>
                    <div className="mt-1 text-sm" style={{ color: '#1C2321' }}>{r.courseName}</div>
                    <div className="text-xs" style={{ color: '#6B7776' }}>
                      {r.hotelName ?? r.areaName ?? '—'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* 接客履歴（過去の完了分） */}
        {!loading && !error && view === 'history' && (
          <div>
            {history.length === 0 ? (
              <p className="py-8 text-center text-sm" style={{ color: '#6B7776' }}>
                接客履歴はまだありません。
              </p>
            ) : (
              <ul className="space-y-2">
                {history.map((h) => (
                  <li
                    key={h.reservationId}
                    className="rounded p-3"
                    style={{ border: '1px solid #ECEFEC', borderRadius: '4px' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold" style={{ color: '#1C2321' }}>
                        {h.dateISO.slice(5).replace('-', '/')} {h.startHHmm}
                      </span>
                      <span className="text-sm tabular-nums" style={{ color: '#3F7A6B' }}>
                        ¥{h.totalAmount.toLocaleString('ja-JP')}
                      </span>
                    </div>
                    <div className="mt-1 text-sm" style={{ color: '#1C2321' }}>{h.courseName}</div>
                    <div className="text-xs" style={{ color: '#6B7776' }}>{h.areaName ?? '—'}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
