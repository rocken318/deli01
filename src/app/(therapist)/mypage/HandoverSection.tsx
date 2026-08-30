'use client';

/**
 * 引き継ぎメモセクション（spec 9章 L810-814 / フェーズ16）。
 *
 * - 過去メモ表示: getHandoverNotesForReservation（therapist セッション・RLS）
 *   RLS により「次回以降の自分の担当予約がある顧客」のメモのみ表示（受入 L1123）。
 * - 新規メモ入力: addHandoverNoteFromMypage（in_service/done のときのみ）
 * - 注意書き常時表示（spec L814 必須）:
 *   「人格・容姿への言及は禁止（開示請求で本人が閲覧しうる）」
 * - スマホ幅 375px 対応（width: 100%, box-sizing: border-box, word-break: break-all）
 * - 3状態: ローディング・結果・エラー
 */

import { useState, useEffect, useTransition } from 'react';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  getHandoverNotesForReservation,
  addHandoverNoteFromMypage,
} from '@/lib/handover/therapist-portal-actions';
import type { HandoverNote } from '@/lib/handover/queries';

const APP_TZ = 'Asia/Tokyo';

interface Props {
  reservationId: string;
  /** 予約の現在ステータス。in_service/done のときのみ入力欄を表示 */
  status: string;
  asSlug?: string;
}

export default function HandoverSection({ reservationId, status, asSlug }: Props) {
  const [notes, setNotes] = useState<HandoverNote[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [body, setBody] = useState('');
  const [submitState, setSubmitState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const canWrite = status === 'in_service' || status === 'done';

  // マウント時にメモを取得
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    getHandoverNotesForReservation(reservationId, asSlug).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setNotes(result.data ?? []);
        setLoadState('ok');
      } else {
        setLoadError(result.error ?? '取得に失敗しました');
        setLoadState('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reservationId, asSlug]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSubmitState('idle');
    startTransition(async () => {
      const result = await addHandoverNoteFromMypage(reservationId, body, asSlug);
      if (result.ok) {
        setBody('');
        setSubmitState('ok');
        setSubmitError(null);
        // 送信後にメモを再取得
        const refreshed = await getHandoverNotesForReservation(reservationId, asSlug);
        if (refreshed.ok) setNotes(refreshed.data ?? []);
      } else {
        setSubmitState('error');
        setSubmitError(result.error ?? '保存に失敗しました');
      }
    });
  }

  return (
    <div
      className="mt-3 mx-4 mb-3"
      style={{
        borderTop: '1px solid #DFE3DE',
        paddingTop: '12px',
      }}
    >
      <p
        className="text-xs font-semibold mb-2"
        style={{ color: '#1C2321' }}
      >
        引き継ぎメモ
      </p>

      {/* ローディング */}
      {loadState === 'loading' && (
        <p className="text-xs" style={{ color: '#6B7776' }}>
          読み込み中...
        </p>
      )}

      {/* エラー */}
      {loadState === 'error' && (
        <p
          className="text-xs p-2 rounded"
          style={{
            background: '#fff0f0',
            color: '#B4453C',
            border: '1px solid #B4453C',
            borderRadius: '4px',
          }}
          role="alert"
        >
          {loadError}
        </p>
      )}

      {/* 過去メモ一覧（空状態） */}
      {loadState === 'ok' && notes.length === 0 && (
        <p className="text-xs" style={{ color: '#6B7776' }}>
          過去のメモはありません
        </p>
      )}

      {/* 過去メモ一覧 */}
      {loadState === 'ok' && notes.length > 0 && (
        <ol className="space-y-2 mb-3" aria-label="過去の引き継ぎメモ">
          {notes.map((note) => (
            <li
              key={note.id}
              className="text-xs p-2 rounded"
              style={{
                background: '#F6F7F5',
                border: '1px solid #DFE3DE',
                borderRadius: '4px',
              }}
            >
              <div
                className="flex items-center justify-between mb-1 flex-wrap gap-1"
                style={{ color: '#6B7776' }}
              >
                <span>{note.therapistName ?? '（担当者）'}</span>
                <span>
                  {format(
                    toZonedTime(new Date(note.createdAt), APP_TZ),
                    'M/d HH:mm',
                  )}
                </span>
              </div>
              <p style={{ color: '#1C2321', wordBreak: 'break-all' }}>{note.body}</p>
            </li>
          ))}
        </ol>
      )}

      {/* 入力欄（in_service/done のときだけ表示） */}
      {canWrite && (
        <form onSubmit={handleSubmit}>
          {/* 注意書き（spec L814・必須・常時表示） */}
          <p
            className="text-xs mb-2 p-2 rounded"
            style={{
              background: '#FFF8EC',
              color: '#C98A2B',
              border: '1px solid #C98A2B',
              borderRadius: '4px',
              lineHeight: 1.5,
            }}
            role="note"
          >
            注意: 人格・容姿への言及は禁止です（開示請求で本人が閲覧しうる内容）
          </p>

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="圧の好み・会話の話題・注意点など（500文字以内）"
            maxLength={500}
            rows={3}
            disabled={isPending}
            aria-label="引き継ぎメモ入力"
            style={{
              width: '100%',
              border: '1px solid #DFE3DE',
              borderRadius: '4px',
              padding: '8px',
              fontSize: '14px',
              color: '#1C2321',
              background: '#FFFFFF',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />

          <div className="flex items-center justify-between mt-1">
            <span className="text-xs" style={{ color: '#6B7776' }}>
              {body.length}/500
            </span>
            <button
              type="submit"
              disabled={isPending || !body.trim()}
              style={{
                background: '#3F7A6B',
                color: '#FFFFFF',
                border: 'none',
                borderRadius: '4px',
                padding: '6px 16px',
                fontSize: '13px',
                fontWeight: 600,
                opacity: isPending || !body.trim() ? 0.5 : 1,
                cursor: isPending || !body.trim() ? 'not-allowed' : 'pointer',
              }}
              aria-busy={isPending}
            >
              {isPending ? '保存中...' : 'メモを保存'}
            </button>
          </div>

          {/* 送信成功 */}
          {submitState === 'ok' && (
            <p
              className="text-xs mt-1"
              style={{ color: '#3F7A6B' }}
              role="status"
            >
              保存しました
            </p>
          )}

          {/* 送信エラー */}
          {submitState === 'error' && submitError && (
            <p
              className="text-xs mt-1 p-1 rounded"
              style={{
                color: '#B4453C',
                background: '#fff0f0',
                borderRadius: '4px',
              }}
              role="alert"
            >
              {submitError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
