'use client';

/**
 * 緊急連絡ボタン（spec 7-3 L706）。
 * 常時表示。押下で管理者向け記録を残す（v1: 実送信はフェーズ20 / TODO(phase20)）。
 * 3状態: 待機 / 確認中 / 送信済み。
 */

import { useState, useTransition } from 'react';
import { recordEmergency } from '@/lib/dispatch-board/therapist-portal-actions';

interface Props {
  reservationId?: string;
  asSlug?: string;
}

export default function EmergencyButton({ reservationId, asSlug }: Props) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleOpen() {
    setPhase('confirm');
    setMessage('');
    setErrorMsg('');
  }

  function handleSend() {
    startTransition(async () => {
      const result = await recordEmergency(
        reservationId ?? null,
        message || '緊急連絡',
        asSlug,
      );
      if (result.ok) {
        setPhase('sent');
      } else {
        setErrorMsg(result.error ?? '記録に失敗しました');
        setPhase('error');
      }
    });
  }

  if (phase === 'sent') {
    return (
      <div
        role="alert"
        className="rounded p-4 text-center"
        style={{
          background: '#fff3cd',
          border: '1px solid #C98A2B',
          color: '#1C2321',
          borderRadius: '4px',
        }}
      >
        <p className="font-semibold mb-1">緊急連絡を記録しました</p>
        <p className="text-sm mb-3">管理者に電話で連絡してください</p>
        <button
          onClick={() => setPhase('idle')}
          className="text-sm underline"
          style={{ color: '#3F7A6B' }}
          type="button"
        >
          閉じる
        </button>
      </div>
    );
  }

  if (phase === 'confirm' || phase === 'error') {
    return (
      <div
        className="rounded p-4"
        style={{
          background: '#fff3cd',
          border: '1px solid #C98A2B',
          borderRadius: '4px',
        }}
      >
        <p className="font-semibold mb-2" style={{ color: '#1C2321' }}>
          緊急連絡を記録しますか？
        </p>
        <textarea
          className="w-full border rounded p-2 text-sm mb-3 resize-none"
          style={{ borderColor: '#DFE3DE', borderRadius: '4px', color: '#1C2321' }}
          rows={3}
          placeholder="状況を入力（省略可）"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
        />
        {phase === 'error' && (
          <p className="text-sm mb-2" style={{ color: '#B4453C' }}>
            {errorMsg}
          </p>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleSend}
            disabled={isPending}
            className="flex-1 py-3 rounded font-semibold text-white disabled:opacity-50"
            style={{ background: '#B4453C', borderRadius: '4px', minHeight: '52px' }}
          >
            {isPending ? '記録中...' : '記録する'}
          </button>
          <button
            type="button"
            onClick={() => setPhase('idle')}
            className="flex-1 py-3 rounded font-semibold"
            style={{
              background: '#FFFFFF',
              border: '1px solid #DFE3DE',
              color: '#1C2321',
              borderRadius: '4px',
              minHeight: '52px',
            }}
          >
            キャンセル
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="w-full py-4 rounded font-semibold text-white"
      style={{
        background: '#B4453C',
        borderRadius: '4px',
        fontSize: '1rem',
        minHeight: '56px',
      }}
      aria-label="緊急連絡を記録する"
    >
      緊急連絡
    </button>
  );
}
