'use client';

/**
 * 配車ブロック（予約詳細ページ / フェーズ5）。
 * 送りON→帰りも自動ON。帰りだけ外せる。両方OFF＝配車不要。
 * モック reservation-dispatch-link-v2.html の JS ロジック準拠。
 */

import { useState, useTransition } from 'react';
import { setReservationDispatchNeeds } from '@/lib/dispatch-board/needs-actions';

interface Props {
  reservationId: string;
  initialNeedsSendCar: boolean;
  initialNeedsReturnCar: boolean;
}

export default function DispatchNeeds({ reservationId, initialNeedsSendCar, initialNeedsReturnCar }: Props) {
  const [needsSendCar, setNeedsSendCar] = useState(initialNeedsSendCar);
  const [needsReturnCar, setNeedsReturnCar] = useState(initialNeedsReturnCar);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [, startTransition] = useTransition();

  const needsDispatch = needsSendCar || needsReturnCar;

  const save = (send: boolean, ret: boolean) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await setReservationDispatchNeeds({ reservationId, needsSendCar: send, needsReturnCar: ret });
      setSaving(false);
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(result.error ?? '更新に失敗しました');
      }
    });
  };

  /** 「配車する」マスタースイッチ変更 */
  const handleNeedsDispatch = (checked: boolean) => {
    const send = checked;
    const ret = checked;
    setNeedsSendCar(send);
    setNeedsReturnCar(ret);
    save(send, ret);
  };

  /** 送りチェック変更: 送りON→帰りも自動ON */
  const handleSendCar = (checked: boolean) => {
    const send = checked;
    const ret = checked ? true : needsReturnCar;
    setNeedsSendCar(send);
    setNeedsReturnCar(ret);
    save(send, ret);
  };

  /** 帰りチェック変更: 帰りON→送りもON（両方OFFは「配車する」もOFF） */
  const handleReturnCar = (checked: boolean) => {
    const ret = checked;
    const send = checked ? (needsSendCar || true) : needsSendCar;
    setNeedsSendCar(send);
    setNeedsReturnCar(ret);
    save(send, ret);
  };

  return (
    <div
      style={{
        border: '1.5px solid #3F7A6B',
        borderRadius: 8,
        padding: '12px 14px',
        background: '#F6FBF9',
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 800,
          color: '#245043',
          marginBottom: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        🚗 配車
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#1f7a54',
            background: '#E6F3EC',
            borderRadius: 10,
            padding: '2px 8px',
            marginLeft: 'auto',
          }}
        >
          既定: 送り＋帰り
        </span>
      </div>

      {/* マスタースイッチ */}
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          border: '1px solid #DFE3DE',
          borderRadius: 8,
          background: '#fff',
          margin: '8px 0 10px',
          cursor: saving ? 'not-allowed' : 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={needsDispatch}
          disabled={saving}
          onChange={(e) => handleNeedsDispatch(e.target.checked)}
          style={{ width: 18, height: 18, accentColor: '#3F7A6B' }}
        />
        <span style={{ fontWeight: 800, fontSize: 13 }}>配車する（送り＋帰り）</span>
      </label>

      {/* サブチェック */}
      <div
        style={{
          paddingLeft: 6,
          borderLeft: '3px solid #cfe3da',
          marginLeft: 6,
          opacity: needsDispatch ? 1 : 0.45,
          transition: 'opacity 0.15s',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '7px 10px',
            border: '1px solid #DFE3DE',
            borderRadius: 8,
            background: '#fff',
            marginBottom: 7,
            cursor: saving || !needsDispatch ? 'not-allowed' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={needsSendCar}
            disabled={saving || !needsDispatch}
            onChange={(e) => handleSendCar(e.target.checked)}
            style={{ width: 15, height: 15, accentColor: '#3F7A6B' }}
          />
          <span style={{ fontWeight: 700 }}>送り車（ホテルへ送る）</span>
          <span style={{ fontSize: 11, color: '#6B7776', marginLeft: 'auto' }}>基本ON</span>
        </label>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '7px 10px',
            border: '1px solid #DFE3DE',
            borderRadius: 8,
            background: '#fff',
            marginBottom: 7,
            cursor: saving || !needsDispatch ? 'not-allowed' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={needsReturnCar}
            disabled={saving || !needsDispatch}
            onChange={(e) => handleReturnCar(e.target.checked)}
            style={{ width: 15, height: 15, accentColor: '#3F7A6B' }}
          />
          <span style={{ fontWeight: 700 }}>帰り車（ホテルから帰す）</span>
          <span style={{ fontSize: 11, color: '#6B7776', marginLeft: 'auto' }}>送りに追従。外せば送りのみ</span>
        </label>
      </div>

      {/* ステータス表示 */}
      <div
        style={{
          fontSize: 12,
          color: '#245043',
          background: '#E6F3EC',
          borderRadius: 6,
          padding: '7px 10px',
          marginTop: 4,
        }}
      >
        {needsSendCar && needsReturnCar && '✔ 配車表に送り＋帰りの2枠が立ちます'}
        {needsSendCar && !needsReturnCar && '✔ 配車表に送りのみ1枠が立ちます'}
        {!needsSendCar && needsReturnCar && '✔ 配車表に帰りのみ1枠が立ちます'}
        {!needsSendCar && !needsReturnCar && (
          <span style={{ color: '#6B7776' }}>配車不要 — 配車表に載りません</span>
        )}
      </div>

      {/* 保存状態 */}
      {saving && (
        <div style={{ fontSize: 11, color: '#6B7776', marginTop: 6 }}>保存中…</div>
      )}
      {saved && !saving && (
        <div style={{ fontSize: 11, color: '#1f7a54', marginTop: 6 }}>✔ 保存しました</div>
      )}
      {error && (
        <div style={{ fontSize: 11, color: '#B4453C', marginTop: 6 }}>{error}</div>
      )}
    </div>
  );
}
