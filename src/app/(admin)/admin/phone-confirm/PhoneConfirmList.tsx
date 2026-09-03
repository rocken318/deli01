'use client';

import { useState, useTransition } from 'react';
import { confirmPhoneCall, listUnconfirmedReservations } from '../orders/actions';
import type { UnconfirmedReservation } from '../orders/actions';

interface Props {
  initialReservations: UnconfirmedReservation[];
}

type CallResult = 'confirmed' | 'no_answer' | 'other';

const CALL_RESULT_LABELS: Record<CallResult, string> = {
  confirmed: '確認済み',
  no_answer: '電話に出なかった',
  other: 'その他',
};

interface ModalState {
  reservationId: string;
  customerName: string;
  customerPhone: string;
}

/**
 * 電話確認クライアントコンポーネント（重大6）。
 * 未確認予約一覧とモーダルでの確認記録 UI を提供する。
 */
export default function PhoneConfirmList({ initialReservations }: Props) {
  const [reservations, setReservations] = useState<UnconfirmedReservation[]>(initialReservations);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [callResult, setCallResult] = useState<CallResult>('confirmed');
  const [note, setNote] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [isPending, startTransition] = useTransition();

  const openModal = (r: UnconfirmedReservation) => {
    setModal({
      reservationId: r.id,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
    });
    setCallResult('confirmed');
    setNote('');
    setErrorMsg('');
  };

  const closeModal = () => {
    setModal(null);
    setErrorMsg('');
  };

  const handleConfirm = () => {
    if (!modal) return;
    startTransition(async () => {
      const result = await confirmPhoneCall(modal.reservationId, callResult, note || undefined);
      if (result.ok) {
        setModal(null);
        setSuccessMsg(`${modal.customerName}様の確認を記録しました`);
        // 一覧をリロード
        const refreshed = await listUnconfirmedReservations();
        if (refreshed.ok && refreshed.data) {
          setReservations(refreshed.data);
        }
      } else {
        setErrorMsg(result.error ?? '確認の記録に失敗しました');
      }
    });
  };

  const formatStartAt = (iso: string) => {
    return new Date(iso).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div>
      {successMsg && (
        <div className="bg-green-50 border border-green-200 text-green-800 rounded p-3 text-sm mb-4">
          {successMsg}
          <button
            onClick={() => setSuccessMsg('')}
            className="ml-2 text-green-600 underline text-xs"
          >
            閉じる
          </button>
        </div>
      )}

      {reservations.length === 0 ? (
        <div className="text-sm text-adm-muted py-8 text-center">
          電話確認が必要な予約はありません
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-adm-border bg-adm-bg">
                <th className="text-left px-3 py-2 font-medium text-adm-text">顧客名</th>
                <th className="text-left px-3 py-2 font-medium text-adm-text">電話番号</th>
                <th className="text-left px-3 py-2 font-medium text-adm-text">施術開始</th>
                <th className="text-left px-3 py-2 font-medium text-adm-text">担当</th>
                <th className="text-left px-3 py-2 font-medium text-adm-text">電話確認</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {reservations.map((r) => (
                <tr key={r.id} className="border-b border-adm-border hover:bg-adm-bg/50">
                  <td className="px-3 py-2">{r.customerName}</td>
                  <td className="px-3 py-2">
                    <a
                      href={`tel:${r.customerPhone}`}
                      className="text-adm-primary underline"
                    >
                      {r.customerPhone}
                    </a>
                  </td>
                  <td className="px-3 py-2">{formatStartAt(r.startAtISO)}</td>
                  <td className="px-3 py-2">{r.therapistName}</td>
                  <td className="px-3 py-2">
                    <span className="inline-block px-2 py-0.5 text-xs rounded bg-yellow-100 text-yellow-800 border border-yellow-200">
                      未確認
                    </span>
                    {r.callCount > 0 && (
                      <div className="text-xs text-adm-muted mt-1">
                        架電{r.callCount}回・最終:{' '}
                        {r.lastResult === 'no_answer' ? '不通' : r.lastResult === 'other' ? 'その他' : '確認'}
                        {r.lastCalledAtISO ? ` (${formatStartAt(r.lastCalledAtISO)})` : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => openModal(r)}
                      className="px-3 py-1 bg-adm-primary text-white text-xs rounded hover:opacity-90 transition-opacity"
                    >
                      確認記録
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 確認記録モーダル */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-adm-surface rounded shadow-lg p-6 w-full max-w-sm mx-4">
            <h2 className="text-base font-semibold text-adm-text mb-1">電話確認を記録</h2>
            <p className="text-xs text-adm-muted mb-4">
              {modal.customerName}様（{modal.customerPhone}）
            </p>

            {errorMsg && (
              <div className="bg-red-50 border border-red-200 text-red-800 rounded p-2 text-xs mb-3">
                {errorMsg}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-adm-text mb-1">
                  通話結果 <span className="text-red-500">*</span>
                </label>
                <div className="space-y-2">
                  {(Object.entries(CALL_RESULT_LABELS) as [CallResult, string][]).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="callResult"
                        value={value}
                        checked={callResult === value}
                        onChange={() => setCallResult(value)}
                      />
                      <span className="text-sm">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-adm-text mb-1">メモ（任意）</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="折り返し不要、留守電済みなど"
                  className="w-full border border-adm-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-adm-primary resize-none"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <button
                onClick={handleConfirm}
                disabled={isPending}
                className="flex-1 bg-adm-primary text-white rounded px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                {isPending ? '記録中…' : '記録する'}
              </button>
              <button
                onClick={closeModal}
                disabled={isPending}
                className="px-3 py-2 border border-adm-border rounded text-sm text-adm-text hover:bg-adm-bg disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
