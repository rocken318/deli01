'use client';

/**
 * ホテル情報パネル＋変更コンポーネント（共通）。
 * 配車ボード・予約一覧の両方でホテル名クリック後に展開する。
 * - 情報表示: 実績バッジ・迎え方・カードキー・ゲストチャージ・入店注意・住所・地図・実効交通費
 * - ホテル変更: 名前で絞り込めるプルダウン＋変更ボタン
 */

import { useState, useTransition } from 'react';
import type { HotelLookupRow } from '@/lib/hotels/hotel-lookup-actions';
import { changeReservationHotel } from '@/lib/reservations/hotel-actions';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 実効交通費: ホテル個別 > エリア既定 > 0 */
function effectiveFee(hotel: HotelLookupRow): number {
  return hotel.transportFee ?? hotel.areaTransportFee ?? 0;
}

function fmtFee(fee: number): string {
  return `¥${fee.toLocaleString('ja-JP')}`;
}

const RECORD_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  ok:      { label: '〇 OK',  color: '#1f7a54', bg: '#E7F3EC' },
  caution: { label: '△ 注意', color: '#8a5d16', bg: '#FBF3E6' },
  blocked: { label: '✖ 停止', color: '#9b2a24', bg: '#FEF2F2' },
};

// ---------------------------------------------------------------------------
// props
// ---------------------------------------------------------------------------

interface Props {
  reservationId: string;
  currentHotelId: string | null;
  currentHotelName: string | null;
  hotels: HotelLookupRow[];
  onChanged: () => void;
  onToast: (text: string, kind: 'ok' | 'error') => void;
}

// ---------------------------------------------------------------------------
// main component
// ---------------------------------------------------------------------------

export default function HotelInfoPanel({
  reservationId,
  currentHotelId,
  currentHotelName,
  hotels,
  onChanged,
  onToast,
}: Props) {
  const [search, setSearch] = useState('');
  const [selectedHotelId, setSelectedHotelId] = useState<string>('');
  const [isPending, startTransition] = useTransition();

  // Current hotel details (from list)
  const currentHotel = currentHotelId
    ? hotels.find((h) => h.id === currentHotelId) ?? null
    : null;

  // Filtered hotels for picker (exclude blocked from selection; show but grayed)
  const filtered = hotels.filter((h) =>
    !search || h.name.toLowerCase().includes(search.toLowerCase()),
  );

  const handleChange = () => {
    if (!selectedHotelId) return;
    startTransition(async () => {
      const result = await changeReservationHotel({
        reservationId,
        hotelId: selectedHotelId,
      });
      if (result.ok && result.data) {
        const { oldFee, newFee, newTotal } = result.data;
        const msg = oldFee === newFee
          ? `ホテルを変更しました（交通費 ${fmtFee(newFee)} ・合計 ${fmtFee(newTotal)}）`
          : `交通費 ${fmtFee(oldFee)}→${fmtFee(newFee)}（合計 ${fmtFee(newTotal)}）`;
        onToast(msg, 'ok');
        setSelectedHotelId('');
        setSearch('');
        onChanged();
      } else {
        onToast(result.error ?? 'ホテル変更に失敗しました', 'error');
      }
    });
  };

  const PANEL: React.CSSProperties = {
    background: '#F6F7F5',
    border: '1px solid #DFE3DE',
    borderRadius: 4,
    padding: '10px 14px',
    fontSize: 12,
    color: '#1C2321',
  };

  const LABEL: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: '#6B7776',
    marginBottom: 2,
    display: 'block',
  };

  const VALUE: React.CSSProperties = {
    fontSize: 12,
    color: '#1C2321',
  };

  const badge = currentHotel ? (RECORD_BADGE[currentHotel.record] ?? null) : null;
  const effFee = currentHotel ? effectiveFee(currentHotel) : null;

  return (
    <div style={PANEL}>
      {/* ──── 情報表示 ──── */}
      {currentHotel ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 24px', marginBottom: 12 }}>
          {/* 実績バッジ */}
          <div>
            <span style={LABEL}>実績</span>
            {badge && (
              <span style={{
                ...VALUE,
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 2,
                fontWeight: 700,
                background: badge.bg,
                color: badge.color,
              }}>
                {badge.label}
              </span>
            )}
          </div>

          {/* 迎え方 */}
          {currentHotel.entryNote && (
            <div>
              <span style={LABEL}>迎え方</span>
              <span style={VALUE}>{currentHotel.entryNote}</span>
            </div>
          )}

          {/* カードキー */}
          <div>
            <span style={LABEL}>カードキー</span>
            <span style={{
              ...VALUE,
              fontWeight: 600,
              color: currentHotel.cardKeyRequired ? '#B4453C' : '#3F7A6B',
            }}>
              {currentHotel.cardKeyRequired ? '要' : '不要'}
            </span>
          </div>

          {/* ゲストチャージ */}
          {currentHotel.guestChargeNote && (
            <div>
              <span style={LABEL}>ゲストチャージ</span>
              <span style={VALUE}>{currentHotel.guestChargeNote}</span>
            </div>
          )}

          {/* 入店注意 / 履歴 */}
          {currentHotel.accessNote && (
            <div style={{ flexBasis: '100%' }}>
              <span style={LABEL}>入店注意 / 履歴</span>
              <span style={{ ...VALUE, whiteSpace: 'pre-line' }}>{currentHotel.accessNote}</span>
            </div>
          )}

          {/* 住所 */}
          {currentHotel.address && (
            <div>
              <span style={LABEL}>住所</span>
              <span style={VALUE}>{currentHotel.address}</span>
            </div>
          )}

          {/* 地図リンク */}
          {currentHotel.mapsUrl && (
            <div>
              <span style={LABEL}>地図</span>
              <a
                href={currentHotel.mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...VALUE, color: '#3F7A6B', textDecoration: 'underline' }}
              >
                Google Maps
              </a>
            </div>
          )}

          {/* 実効交通費 */}
          <div>
            <span style={LABEL}>実効交通費</span>
            <span style={{ ...VALUE, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: '#1C2321' }}>
              {fmtFee(effFee ?? 0)}
            </span>
            {currentHotel.transportFee !== null ? (
              <span style={{ fontSize: 10, color: '#9BA5AF', marginLeft: 4 }}>（ホテル個別）</span>
            ) : currentHotel.areaTransportFee !== null ? (
              <span style={{ fontSize: 10, color: '#9BA5AF', marginLeft: 4 }}>（エリア既定）</span>
            ) : (
              <span style={{ fontSize: 10, color: '#9BA5AF', marginLeft: 4 }}>（設定なし）</span>
            )}
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 10, color: '#9BA5AF', fontSize: 12 }}>
          {currentHotelName ? `「${currentHotelName}」の詳細情報は登録されていません` : 'ホテル未設定（自宅・住所等）'}
        </div>
      )}

      {/* ──── ホテル変更 ──── */}
      <div style={{ borderTop: '1px solid #DFE3DE', paddingTop: 10 }}>
        <span style={{ ...LABEL, marginBottom: 6 }}>ホテルを変更</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* 絞り込み入力 */}
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelectedHotelId(''); // clear selection when search changes
            }}
            placeholder="ホテル名で絞り込み"
            disabled={isPending}
            style={{
              padding: '5px 8px',
              border: '1px solid #DFE3DE',
              borderRadius: 4,
              fontSize: 12,
              width: 160,
              background: '#fff',
              color: '#1C2321',
            }}
            aria-label="ホテル名絞り込み"
          />

          {/* プルダウン */}
          <select
            value={selectedHotelId}
            onChange={(e) => setSelectedHotelId(e.target.value)}
            disabled={isPending}
            style={{
              padding: '5px 8px',
              border: '1px solid #DFE3DE',
              borderRadius: 4,
              fontSize: 12,
              minWidth: 200,
              maxWidth: 300,
              background: '#fff',
              color: '#1C2321',
            }}
            aria-label="変更先ホテル選択"
          >
            <option value="">ホテルを選択…</option>
            {filtered.map((h) => (
              <option
                key={h.id}
                value={h.id}
                disabled={h.isBlocked}
                style={{ color: h.isBlocked ? '#B9C2BD' : '#1C2321' }}
              >
                {h.isBlocked ? `[停止] ${h.name}` : h.name}
                {h.areaName ? ` (${h.areaName})` : ''}
                {' — '}
                {fmtFee(effectiveFee(h))}
              </option>
            ))}
          </select>

          {/* 変更ボタン */}
          <button
            type="button"
            onClick={handleChange}
            disabled={isPending || !selectedHotelId}
            style={{
              padding: '5px 14px',
              background: selectedHotelId && !isPending ? '#3F7A6B' : '#DFE3DE',
              color: selectedHotelId && !isPending ? '#fff' : '#9BA5AF',
              border: 'none',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 700,
              cursor: isPending || !selectedHotelId ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {isPending ? '変更中…' : '変更'}
          </button>
        </div>
      </div>
    </div>
  );
}
