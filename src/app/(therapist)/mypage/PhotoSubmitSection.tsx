'use client';

/**
 * キャスト本人のプロフィール写真 提出セクション（機能H）。
 * アップロード → pending で提出（承認後に公開）。自分の提出状況も一覧表示。
 * 掲載同意チェック必須。デザインは spec 12-2（明るい管理側トークン）。
 */

import { useEffect, useRef, useState } from 'react';
import {
  submitMyPhoto,
  listMyPhotoSubmissions,
  type MyPhotoSubmission,
} from '@/lib/therapist/photo-submit-actions';

const T = {
  bg: '#FFFFFF',
  text: '#1C2321',
  border: '#DFE3DE',
  primary: '#3F7A6B',
  muted: '#6B7776',
  caution: '#C98A2B',
  danger: '#B4453C',
  radius: '4px',
} as const;

const STATUS: Record<MyPhotoSubmission['status'], { label: string; color: string }> = {
  pending: { label: '承認待ち', color: T.caution },
  approved: { label: '承認済み（掲載可）', color: T.primary },
  rejected: { label: '却下', color: T.danger },
};

export default function PhotoSubmitSection({ asSlug }: { asSlug?: string }) {
  const [items, setItems] = useState<MyPhotoSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    const r = await listMyPhotoSubmissions(asSlug);
    if (r.ok) setItems(r.data ?? []);
    setLoading(false);
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asSlug]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMsg({ ok: false, text: '写真を選んでください' });
      return;
    }
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set('file', file);
    fd.set('consent', consent ? 'on' : '');
    if (noteRef.current?.value) fd.set('note', noteRef.current.value);
    if (asSlug) fd.set('asSlug', asSlug);
    const r = await submitMyPhoto(fd);
    setBusy(false);
    if (r.ok) {
      setMsg({ ok: true, text: '提出しました。承認されると掲載されます。' });
      setConsent(false);
      if (fileRef.current) fileRef.current.value = '';
      if (noteRef.current) noteRef.current.value = '';
      void reload();
    } else {
      setMsg({ ok: false, text: r.error ?? '提出に失敗しました' });
    }
  };

  const card: React.CSSProperties = {
    background: T.bg,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
  };

  return (
    <div>
      <h2
        style={{
          fontSize: '13px',
          fontWeight: 600,
          color: T.muted,
          marginBottom: '8px',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        プロフィール写真
      </h2>

      <form onSubmit={onSubmit} style={{ ...card, padding: '12px', marginBottom: '10px' }}>
        <p style={{ fontSize: '12px', color: T.muted, marginBottom: '8px' }}>
          写真を提出すると、店舗が確認・承認したうえで掲載されます（すぐには公開されません）。
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ fontSize: '13px', color: T.text, display: 'block', marginBottom: '8px' }}
        />
        <input
          ref={noteRef}
          type="text"
          placeholder="ひとことメモ（任意）"
          maxLength={200}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            border: `1px solid ${T.border}`,
            borderRadius: T.radius,
            padding: '8px',
            fontSize: '13px',
            color: T.text,
            colorScheme: 'light',
            marginBottom: '8px',
          }}
        />
        <label
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'flex-start',
            fontSize: '12px',
            color: T.text,
            marginBottom: '10px',
          }}
        >
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            style={{ marginTop: '2px' }}
          />
          <span>この写真を自分のプロフィールとして掲載することに同意します（承認後に公開されます）。</span>
        </label>
        <button
          type="submit"
          disabled={busy}
          style={{
            width: '100%',
            background: T.primary,
            color: '#fff',
            border: 'none',
            borderRadius: T.radius,
            padding: '10px',
            fontSize: '14px',
            fontWeight: 600,
            minHeight: '48px',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? '提出中…' : '写真を提出する'}
        </button>
        {msg && (
          <p style={{ fontSize: '12px', marginTop: '8px', color: msg.ok ? T.primary : T.danger }}>
            {msg.text}
          </p>
        )}
      </form>

      {/* 提出状況 */}
      {!loading && items.length > 0 && (
        <div style={{ ...card, overflow: 'hidden' }}>
          {items.map((it, i) => (
            <div
              key={it.id}
              style={{
                display: 'flex',
                gap: '10px',
                alignItems: 'center',
                padding: '10px 12px',
                borderTop: i === 0 ? 'none' : `1px solid ${T.border}`,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={it.url}
                alt="提出写真"
                width={44}
                height={44}
                style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: T.radius, flex: '0 0 auto' }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: STATUS[it.status].color }}>
                  {STATUS[it.status].label}
                </span>
                <p style={{ fontSize: '11px', color: T.muted, margin: '2px 0 0' }}>{it.createdAt}</p>
                {it.status === 'rejected' && it.reviewNote && (
                  <p style={{ fontSize: '11px', color: T.danger, margin: '2px 0 0' }}>
                    理由: {it.reviewNote}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
