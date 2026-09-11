'use client';

/**
 * CTI 受付コンソール クライアントコンポーネント（フェーズ14）。
 * - 4秒ごとにポーリング（getRecentIncomingCalls）
 * - 新着着信をポップ/行で表示
 * - 「この番号で予約入力」→ /admin/orders?phone=<phone>
 * - 「対応済み」→ markCtiHandled
 * - 「模擬着信」→ simulateIncoming（回線なしでデモ可）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatInTimeZone } from 'date-fns-tz';
import {
  getRecentIncomingCalls,
  markCtiHandled,
  simulateIncoming,
} from '@/lib/cti/actions';
import type { CtiEvent } from '@/lib/cti/actions';

const TZ = 'Asia/Tokyo';
const POLL_MS = 4500;
const PHONE_RE = /^0[0-9]{9,10}$/;

interface Props {
  initialEvents: CtiEvent[];
}

export default function CtiConsoleClient({ initialEvents }: Props) {
  const router = useRouter();
  const [events, setEvents] = useState<CtiEvent[]>(initialEvents);
  const [polling, setPolling] = useState(true);
  const [pollError, setPollError] = useState<string | null>(null);

  // 模擬着信
  const [simPhone, setSimPhone] = useState('');
  const [simLoading, setSimLoading] = useState(false);
  const [simMsg, setSimMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 対応済みボタン
  const [handlingId, setHandlingId] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEvents = useCallback(async () => {
    const result = await getRecentIncomingCalls(300);
    if (result.ok && result.data) {
      setEvents(result.data);
      setPollError(null);
    } else {
      setPollError(result.error ?? 'ポーリングに失敗しました');
    }
  }, []);

  useEffect(() => {
    if (!polling) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      void fetchEvents();
    }, POLL_MS);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [polling, fetchEvents]);

  const handleMarkHandled = async (id: string) => {
    setHandlingId(id);
    const r = await markCtiHandled(id);
    setHandlingId(null);
    if (r.ok) {
      setEvents((prev) =>
        prev.map((e) => (e.id === id ? { ...e, handled: true } : e)),
      );
    }
  };

  const handleSimulate = async () => {
    if (!PHONE_RE.test(simPhone)) {
      setSimMsg({ ok: false, text: '電話番号は 0 から始まる10〜11桁で入力してください' });
      return;
    }
    setSimLoading(true);
    setSimMsg(null);
    const r = await simulateIncoming(simPhone);
    setSimLoading(false);
    if (r.ok) {
      setSimMsg({
        ok: true,
        text: r.data?.matched
          ? `着信を記録しました（既存顧客に一致）`
          : `着信を記録しました（新規番号）`,
      });
      setSimPhone('');
      await fetchEvents();
    } else {
      setSimMsg({ ok: false, text: r.error ?? '模擬着信に失敗しました' });
    }
  };

  const handleOrderEntry = (phone: string) => {
    router.push(`/admin/orders?phone=${encodeURIComponent(phone)}`);
  };

  const unhandledCount = events.filter((e) => !e.handled).length;

  return (
    <div className="space-y-4">
      {/* 模擬着信パネル */}
      <div className="bg-adm-surface border border-adm-border p-4" style={{ borderRadius: '4px' }}>
        <h2 className="text-sm font-semibold text-adm-text mb-2">模擬着信（デモ用）</h2>
        <p className="text-xs text-adm-muted mb-3">
          回線が未接続でも着信ポップの動作確認ができます。実回線からは /api/cti/incoming を叩いてください。
        </p>
        <div className="flex gap-2 items-center flex-wrap">
          <input
            type="tel"
            value={simPhone}
            onChange={(e) => setSimPhone(e.target.value)}
            placeholder="09012345678"
            className="border border-adm-border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-adm-primary w-44"
          />
          <button
            onClick={() => { void handleSimulate(); }}
            disabled={simLoading}
            className="bg-adm-primary text-white rounded px-4 py-1.5 text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {simLoading ? '送信中…' : '模擬着信'}
          </button>
        </div>
        {simMsg && (
          <p className={`text-xs mt-2 ${simMsg.ok ? 'text-adm-primary' : 'text-adm-warn'}`}>
            {simMsg.text}
          </p>
        )}
      </div>

      {/* ポーリング制御 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-adm-text">
            着信一覧（直近5分）
            {unhandledCount > 0 && (
              <span className="ml-2 inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold rounded-full bg-adm-warn text-white">
                {unhandledCount}
              </span>
            )}
          </span>
          {pollError && (
            <span className="text-xs text-adm-alert">{pollError}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-adm-muted">
            {polling ? '自動更新中（4.5秒ごと）' : '自動更新停止中'}
          </span>
          <button
            onClick={() => setPolling((p) => !p)}
            className="text-xs border border-adm-border rounded px-2 py-1 text-adm-muted hover:bg-adm-bg transition-colors"
          >
            {polling ? '停止' : '再開'}
          </button>
          <button
            onClick={() => { void fetchEvents(); }}
            className="text-xs border border-adm-border rounded px-2 py-1 text-adm-muted hover:bg-adm-bg transition-colors"
          >
            今すぐ更新
          </button>
        </div>
      </div>

      {/* 着信一覧 */}
      {events.length === 0 ? (
        <div className="bg-adm-surface border border-adm-border rounded p-8 text-center">
          <p className="text-adm-muted text-sm">直近5分に着信はありません</p>
          <p className="text-adm-muted text-xs mt-1">
            「模擬着信」ボタンで動作確認できます。
          </p>
        </div>
      ) : (
        <div className="bg-adm-surface border border-adm-border" style={{ borderRadius: '4px' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-adm-border text-left text-xs text-adm-muted">
                <th className="px-3 py-2">着信時刻</th>
                <th className="px-3 py-2">電話番号</th>
                <th className="px-3 py-2">顧客</th>
                <th className="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr
                  key={ev.id}
                  className={`border-b border-adm-border last:border-0 transition-colors ${
                    ev.handled ? 'opacity-50' : 'bg-adm-surface'
                  }`}
                >
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                    {formatInTimeZone(new Date(ev.occurredAtISO), TZ, 'M/d HH:mm:ss')}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-adm-primary font-medium">
                      {ev.phone}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {ev.matchedName ? (
                      <span className="font-semibold text-adm-text">{ev.matchedName}</span>
                    ) : (
                      <span className="text-adm-muted text-xs">新規（未登録）</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2 flex-wrap">
                      {!ev.handled && (
                        <>
                          <button
                            onClick={() => handleOrderEntry(ev.phone)}
                            className="bg-adm-primary text-white rounded px-3 py-1 text-xs font-medium hover:opacity-90 transition-opacity whitespace-nowrap"
                          >
                            この番号で予約入力
                          </button>
                          <button
                            onClick={() => { void handleMarkHandled(ev.id); }}
                            disabled={handlingId === ev.id}
                            className="border border-adm-border rounded px-3 py-1 text-xs text-adm-muted hover:bg-adm-bg transition-colors disabled:opacity-50 whitespace-nowrap"
                          >
                            {handlingId === ev.id ? '処理中…' : '対応済み'}
                          </button>
                        </>
                      )}
                      {ev.handled && (
                        <span className="text-xs text-adm-muted">対応済み</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
