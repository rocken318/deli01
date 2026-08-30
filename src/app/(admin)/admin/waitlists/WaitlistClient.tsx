'use client';

/**
 * キャンセル待ちのクライアント UI（フェーズ15）。登録フォーム + 一覧。
 */

import { useState, useTransition } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import { registerWaitlist, type WaitlistRow } from '@/lib/booking/waitlist-actions';

export interface AreaChoice { id: string; name: string }
export interface TherapistChoice { id: string; name: string }
export interface CourseChoice { id: string; name: string }

const TZ = 'Asia/Tokyo';

export function WaitlistClient({
  rows,
  areas,
  therapists,
  courses,
}: {
  rows: WaitlistRow[];
  areas: AreaChoice[];
  therapists: TherapistChoice[];
  courses: CourseChoice[];
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [form, setForm] = useState({
    phone: '',
    desiredDate: '',
    timeFrom: '',
    timeTo: '',
    areaId: '',
    therapistId: '',
    courseId: '',
    note: '',
  });

  function submit() {
    if (!form.phone || !form.desiredDate) {
      setMsg({ text: '電話番号と希望日は必須です', ok: false });
      return;
    }
    startTransition(async () => {
      const res = await registerWaitlist({
        phone: form.phone,
        desiredDate: form.desiredDate,
        timeFrom: form.timeFrom || undefined,
        timeTo: form.timeTo || undefined,
        areaId: form.areaId || undefined,
        therapistId: form.therapistId || undefined,
        courseId: form.courseId || undefined,
        note: form.note || undefined,
      });
      setMsg({ text: res.ok ? '登録しました' : res.error ?? '失敗しました', ok: res.ok });
      if (res.ok) location.reload();
    });
  }

  const inputCls = 'border border-adm-border px-2 py-1 text-sm';

  return (
    <div className="space-y-6">
      {/* 登録フォーム */}
      <div className="bg-adm-surface border border-adm-border p-4" style={{ borderRadius: '4px' }}>
        <h2 className="text-sm font-semibold mb-3">新規登録</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label className="text-xs text-adm-muted">
            電話番号*
            <input className={`block mt-1 w-full ${inputCls}`} value={form.phone}
              onChange={(e) => setForm((s) => ({ ...s, phone: e.target.value }))}
              placeholder="09012345678" style={{ borderRadius: '4px' }} />
          </label>
          <label className="text-xs text-adm-muted">
            希望日*
            <input type="date" className={`block mt-1 w-full ${inputCls}`} value={form.desiredDate}
              onChange={(e) => setForm((s) => ({ ...s, desiredDate: e.target.value }))} style={{ borderRadius: '4px' }} />
          </label>
          <label className="text-xs text-adm-muted">
            時間帯（開始）
            <input type="time" className={`block mt-1 w-full ${inputCls}`} value={form.timeFrom}
              onChange={(e) => setForm((s) => ({ ...s, timeFrom: e.target.value }))} style={{ borderRadius: '4px' }} />
          </label>
          <label className="text-xs text-adm-muted">
            時間帯（終了）
            <input type="time" className={`block mt-1 w-full ${inputCls}`} value={form.timeTo}
              onChange={(e) => setForm((s) => ({ ...s, timeTo: e.target.value }))} style={{ borderRadius: '4px' }} />
          </label>
          <label className="text-xs text-adm-muted">
            エリア
            <select className={`block mt-1 w-full ${inputCls}`} value={form.areaId}
              onChange={(e) => setForm((s) => ({ ...s, areaId: e.target.value }))} style={{ borderRadius: '4px' }}>
              <option value="">指定なし</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-adm-muted">
            セラピスト
            <select className={`block mt-1 w-full ${inputCls}`} value={form.therapistId}
              onChange={(e) => setForm((s) => ({ ...s, therapistId: e.target.value }))} style={{ borderRadius: '4px' }}>
              <option value="">指定なし</option>
              {therapists.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-adm-muted">
            コース
            <select className={`block mt-1 w-full ${inputCls}`} value={form.courseId}
              onChange={(e) => setForm((s) => ({ ...s, courseId: e.target.value }))} style={{ borderRadius: '4px' }}>
              <option value="">指定なし</option>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-adm-muted">
            メモ
            <input className={`block mt-1 w-full ${inputCls}`} value={form.note}
              onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))} style={{ borderRadius: '4px' }} />
          </label>
        </div>
        <button type="button" disabled={pending} onClick={submit}
          className="mt-3 px-4 py-1.5 text-sm bg-adm-primary text-white disabled:opacity-50" style={{ borderRadius: '4px' }}>
          登録する
        </button>
        {msg && (
          <p className={`mt-2 text-sm ${msg.ok ? 'text-adm-primary' : 'text-adm-danger'}`} role="status">{msg.text}</p>
        )}
      </div>

      {/* 一覧 */}
      {rows.length === 0 ? (
        <p className="text-adm-muted">キャンセル待ちはありません。</p>
      ) : (
        <div className="bg-adm-surface border border-adm-border" style={{ borderRadius: '4px' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-adm-border text-left text-xs text-adm-muted">
                <th className="px-3 py-2">希望日</th>
                <th className="px-3 py-2">時間帯</th>
                <th className="px-3 py-2">エリア</th>
                <th className="px-3 py-2">セラピスト</th>
                <th className="px-3 py-2">コース</th>
                <th className="px-3 py-2">電話</th>
                <th className="px-3 py-2">状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="border-b border-adm-border last:border-0">
                  <td className="px-3 py-2">{w.desiredDate}</td>
                  <td className="px-3 py-2">{w.timeFrom ?? '—'}{w.timeTo ? `〜${w.timeTo}` : ''}</td>
                  <td className="px-3 py-2">{w.areaName ?? '指定なし'}</td>
                  <td className="px-3 py-2">{w.therapistName ?? '指定なし'}</td>
                  <td className="px-3 py-2">{w.courseName ?? '指定なし'}</td>
                  <td className="px-3 py-2">{w.phone}</td>
                  <td className="px-3 py-2">
                    <span className="text-xs px-2 py-0.5 bg-adm-bg" style={{ borderRadius: '4px' }}>
                      {w.status === 'waiting' ? '待機中' : w.status === 'notified' ? '通知済' : w.status}
                    </span>
                    <span className="ml-2 text-xs text-adm-muted">
                      {formatInTimeZone(new Date(w.createdAtISO), TZ, 'M/d HH:mm')}
                    </span>
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
