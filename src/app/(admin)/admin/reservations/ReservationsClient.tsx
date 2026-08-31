'use client';

/**
 * 予約管理のクライアント UI（フェーズ15）。
 * 当日オプション追加（延長）とキャンセルを行う。spec 12-2 準拠。
 */

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { formatInTimeZone } from 'date-fns-tz';
import { addSameDayExtension } from '@/lib/booking/extension-actions';
import { cancelReservation } from '@/lib/booking/cancel-actions';

export interface ReservationRow {
  id: string;
  customerName: string;
  therapistName: string;
  therapistSlug: string;
  courseName: string;
  startAtISO: string;
  status: string;
  totalAmount: number;
  options: string | null;
}

export interface OptionChoice {
  id: string;
  name: string;
  durationMin: number;
  price: number;
}

const TZ = 'Asia/Tokyo';

const STATUS_LABEL: Record<string, string> = {
  confirmed: '確定',
  enroute: '移動中',
  in_service: '施術中',
};

export function ReservationsClient({
  reservations,
  options,
}: {
  reservations: ReservationRow[];
  options: OptionChoice[];
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [optionByRes, setOptionByRes] = useState<Record<string, string>>({});
  const [reasonByRes, setReasonByRes] = useState<Record<string, string>>({});

  if (reservations.length === 0) {
    return <p className="text-adm-muted">対象の予約はありません。</p>;
  }

  function runExtension(id: string) {
    const optionId = optionByRes[id];
    if (!optionId) {
      setMsg({ id, text: 'オプションを選択してください', ok: false });
      return;
    }
    startTransition(async () => {
      const res = await addSameDayExtension(id, optionId);
      setMsg({ id, text: res.ok ? '延長を追加しました' : res.error ?? '失敗しました', ok: res.ok });
      if (res.ok) location.reload();
    });
  }

  function runCancel(id: string) {
    const reason = reasonByRes[id]?.trim();
    if (!reason) {
      setMsg({ id, text: 'キャンセル理由を入力してください', ok: false });
      return;
    }
    if (!confirm('この予約をキャンセルしますか？')) return;
    startTransition(async () => {
      const res = await cancelReservation(id, 'customer', reason);
      setMsg({
        id,
        text: res.ok
          ? `キャンセルしました（請求 ${res.data?.feePercent}% / ¥${res.data?.fee.toLocaleString('en-US')}）`
          : res.error ?? '失敗しました',
        ok: res.ok,
      });
      if (res.ok) location.reload();
    });
  }

  return (
    <div className="space-y-3">
      {reservations.map((r) => (
        <div
          key={r.id}
          className="bg-adm-surface border border-adm-border p-4"
          style={{ borderRadius: '4px' }}
        >
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="text-sm">
              <span className="font-semibold">
                {formatInTimeZone(new Date(r.startAtISO), TZ, 'M/d HH:mm')}
              </span>
              <Link
                href={`/admin/therapists/${r.therapistSlug}/schedule?date=${formatInTimeZone(new Date(r.startAtISO), TZ, 'yyyy-MM-dd')}`}
                className="ml-3 hover:underline text-adm-primary"
              >
                {r.therapistName}
              </Link>
              <span className="ml-3 text-adm-muted">
                {r.customerName} / {r.courseName}
              </span>
              <span className="ml-3 inline-block px-2 py-0.5 bg-adm-bg text-xs" style={{ borderRadius: '4px' }}>
                {STATUS_LABEL[r.status] ?? r.status}
              </span>
              {r.options && (
                <span className="ml-3 text-xs text-adm-muted">オプション: {r.options}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-adm-muted">¥{r.totalAmount.toLocaleString('en-US')}</span>
              <Link
                href={`/admin/reservations/${r.id}`}
                className="text-xs px-2 py-1 border border-adm-border text-adm-text hover:border-adm-primary hover:text-adm-primary transition-colors"
                style={{ borderRadius: '4px' }}
              >
                詳細
              </Link>
            </div>
          </div>

          <div className="mt-3 flex items-end gap-3 flex-wrap">
            {/* 延長 */}
            <div className="flex items-end gap-2">
              <label className="text-xs text-adm-muted">
                当日延長
                <select
                  className="block mt-1 border border-adm-border px-2 py-1 text-sm"
                  style={{ borderRadius: '4px' }}
                  value={optionByRes[r.id] ?? ''}
                  onChange={(e) => setOptionByRes((s) => ({ ...s, [r.id]: e.target.value }))}
                >
                  <option value="">選択</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}（+{o.durationMin}分 / ¥{o.price.toLocaleString('en-US')}）
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={pending}
                onClick={() => runExtension(r.id)}
                className="px-3 py-1.5 text-sm bg-adm-primary text-white disabled:opacity-50"
                style={{ borderRadius: '4px' }}
              >
                延長を追加
              </button>
            </div>

            {/* キャンセル */}
            <div className="flex items-end gap-2">
              <label className="text-xs text-adm-muted">
                キャンセル理由
                <input
                  type="text"
                  className="block mt-1 border border-adm-border px-2 py-1 text-sm"
                  style={{ borderRadius: '4px' }}
                  value={reasonByRes[r.id] ?? ''}
                  onChange={(e) => setReasonByRes((s) => ({ ...s, [r.id]: e.target.value }))}
                  placeholder="理由"
                />
              </label>
              <button
                type="button"
                disabled={pending}
                onClick={() => runCancel(r.id)}
                className="px-3 py-1.5 text-sm border border-adm-danger text-adm-danger disabled:opacity-50"
                style={{ borderRadius: '4px' }}
              >
                キャンセル
              </button>
            </div>
          </div>

          {msg && msg.id === r.id && (
            <p
              className={`mt-2 text-sm ${msg.ok ? 'text-adm-primary' : 'text-adm-danger'}`}
              role="status"
            >
              {msg.text}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
