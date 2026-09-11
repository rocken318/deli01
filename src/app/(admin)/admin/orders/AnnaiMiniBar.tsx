'use client';

import { formatInTimeZone } from 'date-fns-tz';
import type { AnnaiMiniItem } from '@/lib/annai/mini-actions';

const TZ = 'Asia/Tokyo';

function fmt(iso: string): string {
  return formatInTimeZone(new Date(iso), TZ, 'HH:mm');
}

function chipLabel(item: AnnaiMiniItem): string {
  if (item.kind === 'now') {
    const until = item.untilISO ? `〜${fmt(item.untilISO)}` : '';
    return `今すぐ${until}`;
  }
  if (item.kind === 'from' && item.fromISO) {
    const from = fmt(item.fromISO);
    const until = item.untilISO ? `〜${fmt(item.untilISO)}` : '';
    return `${from}から${until}`;
  }
  if (item.kind === 'done') return '上がり';
  if (item.busyNow) return '接客中';
  return '—';
}

function chipColor(item: AnnaiMiniItem): { bg: string; color: string; border: string } {
  if (item.kind === 'now' && !item.busyNow) return { bg: '#EAF3EF', color: '#2c6152', border: '#3F7A6B' };
  if (item.kind === 'from') return { bg: '#FBF3E6', color: '#8a5d16', border: '#C98A2B' };
  return { bg: '#F6F7F5', color: '#9BA5AF', border: '#DFE3DE' };
}

interface Props {
  items: AnnaiMiniItem[];
  onPick: (t: { id: string; slug: string; name: string }) => void;
}

export default function AnnaiMiniBar({ items, onPick }: Props) {
  if (items.length === 0) return null;
  return (
    <div
      style={{
        overflowX: 'auto', display: 'flex', gap: 8, padding: '8px 0',
        marginBottom: 12, borderBottom: '1px solid #DFE3DE',
      }}
    >
      <span style={{ fontSize: 11, color: '#9BA5AF', whiteSpace: 'nowrap', alignSelf: 'center', flexShrink: 0 }}>
        空き状況:
      </span>
      {items.map((item) => {
        const c = chipColor(item);
        return (
          <button
            key={item.therapistId}
            onClick={() => onPick({ id: item.therapistId, slug: item.slug, name: item.name })}
            style={{
              flexShrink: 0, border: `1px solid ${c.border}`, background: c.bg,
              color: c.color, borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
              fontSize: 12, whiteSpace: 'nowrap',
            }}
          >
            <span style={{ fontWeight: 600 }}>{item.name}</span>
            <span style={{ marginLeft: 6, fontSize: 11 }}>{chipLabel(item)}</span>
            {item.gapMin !== null && item.gapMin > 0 && (
              <span style={{ marginLeft: 4, fontSize: 10, color: '#9BA5AF' }}>空き{item.gapMin}分</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
