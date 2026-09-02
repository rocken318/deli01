'use client';

/**
 * 写真承認クライアント（機能H）。承認（顔出し設定＋alt）/却下（理由）を行う。
 * デザインは spec 12-2（管理側）。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  approvePhotoSubmission,
  rejectPhotoSubmission,
  type PendingPhotoSubmission,
} from '@/lib/cms/photo-review-actions';

type Face = 'face' | 'eyes' | 'none';
const FACE_LABEL: Record<Face, string> = { face: '顔出し', eyes: '目のみ', none: '非表示' };

export default function PhotoReviewClient({
  initialItems,
}: {
  initialItems: PendingPhotoSubmission[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const approve = async (id: string, faceVisibility: Face, alt: string) => {
    setBusyId(id);
    setErr(null);
    const r = await approvePhotoSubmission({ id, faceVisibility, alt: alt || undefined });
    setBusyId(null);
    if (r.ok) startTransition(() => router.refresh());
    else setErr(r.error ?? '承認に失敗しました');
  };
  const reject = async (id: string) => {
    const note = window.prompt('却下理由（任意・本人に表示されます）') ?? undefined;
    setBusyId(id);
    setErr(null);
    const r = await rejectPhotoSubmission({ id, note });
    setBusyId(null);
    if (r.ok) startTransition(() => router.refresh());
    else setErr(r.error ?? '却下に失敗しました');
  };

  if (initialItems.length === 0) {
    return <p className="text-sm text-adm-muted">承認待ちの写真はありません。</p>;
  }

  return (
    <div className="space-y-3">
      {err && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-2 text-sm">{err}</div>}
      {initialItems.map((it) => (
        <ReviewRow
          key={it.id}
          item={it}
          busy={busyId === it.id || isPending}
          onApprove={approve}
          onReject={reject}
        />
      ))}
    </div>
  );
}

function ReviewRow({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: PendingPhotoSubmission;
  busy: boolean;
  onApprove: (id: string, face: Face, alt: string) => void;
  onReject: (id: string) => void;
}) {
  const [face, setFace] = useState<Face>('face');
  const [alt, setAlt] = useState('');

  return (
    <div className="bg-adm-surface border border-adm-line rounded p-3 flex flex-wrap gap-3 items-start">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.url}
        alt="提出写真"
        className="rounded object-cover"
        style={{ width: 96, height: 96, flex: '0 0 auto' }}
      />
      <div className="flex-1 min-w-[220px]">
        <p className="text-sm font-semibold text-adm-text">
          {item.therapistName}{' '}
          <span className="text-xs text-adm-muted">/ {item.therapistSlug}</span>
        </p>
        <p className="text-xs text-adm-muted mt-0.5">提出: {item.createdAt}</p>
        <p className="text-xs mt-0.5" style={{ color: item.consentFlag ? '#3F7A6B' : '#B4453C' }}>
          {item.consentFlag ? '本人の掲載同意あり' : '⚠ 同意なし（公開時にブロックされます）'}
        </p>
        {item.castNote && <p className="text-xs text-adm-text mt-1">メモ: {item.castNote}</p>}

        <div className="flex flex-wrap items-end gap-2 mt-2">
          <label className="text-xs text-adm-muted">
            表示<br />
            <select
              value={face}
              onChange={(e) => setFace(e.target.value as Face)}
              className="border border-adm-line rounded px-2 py-1 text-sm text-adm-text bg-white [color-scheme:light]"
            >
              {(Object.keys(FACE_LABEL) as Face[]).map((f) => (
                <option key={f} value={f}>{FACE_LABEL[f]}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-adm-muted flex-1 min-w-[140px]">
            代替テキスト（alt・任意）<br />
            <input
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              placeholder="例: あおい プロフィール"
              className="border border-adm-line rounded px-2 py-1 text-sm text-adm-text bg-white w-full [color-scheme:light]"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove(item.id, face, alt)}
            className="px-4 py-1.5 text-sm font-semibold rounded bg-adm-primary text-white disabled:opacity-50"
          >
            承認
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReject(item.id)}
            className="px-3 py-1.5 text-sm rounded border border-adm-line text-adm-danger disabled:opacity-50"
          >
            却下
          </button>
        </div>
      </div>
    </div>
  );
}
