'use client';

import { useState } from 'react';
import type { HotelLookupRow } from '@/lib/hotels/hotel-lookup-actions';
import type { HotelRecord } from '@/domain/hotels/record';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FilterChip = 'all' | 'ok' | 'caution' | 'blocked' | 'cardKey' | 'guestCharge';

interface Props {
  initialRows: HotelLookupRow[];
  loadError?: string;
}

// ---------------------------------------------------------------------------
// Styles (inline — admin-side design tokens from spec 12-2)
// ---------------------------------------------------------------------------

const S = {
  bg: '#F6F7F5',
  surface: '#FFFFFF',
  text: '#1C2321',
  muted: '#6B7776',
  primary: '#3F7A6B',
  border: '#DFE3DE',
  warn: '#C98A2B',
  danger: '#B4453C',
} as const;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RecordBadge({ record }: { record: HotelRecord }) {
  if (record === 'blocked') {
    return (
      <span style={{
        fontSize: 15, fontWeight: 800, width: 26, textAlign: 'center',
        borderRadius: 6, display: 'inline-block', padding: '2px 0',
        color: '#a5372e', background: '#FBEAE7',
      }}>✖</span>
    );
  }
  if (record === 'caution') {
    return (
      <span style={{
        fontSize: 15, fontWeight: 800, width: 26, textAlign: 'center',
        borderRadius: 6, display: 'inline-block', padding: '2px 0',
        color: '#8a5d16', background: '#FBF3E6',
      }}>△</span>
    );
  }
  return (
    <span style={{
      fontSize: 15, fontWeight: 800, width: 26, textAlign: 'center',
      borderRadius: 6, display: 'inline-block', padding: '2px 0',
      color: '#1f7a54', background: '#E7F3EC',
    }}>〇</span>
  );
}

function Tag({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, fontWeight: 700,
      borderRadius: 3, padding: '1px 6px', margin: '1px 2px 1px 0',
      background: bg, color,
    }}>{label}</span>
  );
}

function FilterChipButton({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11, padding: '4px 10px',
        border: `1px solid ${active ? S.primary : S.border}`,
        borderRadius: 14,
        background: active ? S.primary : S.surface,
        cursor: 'pointer',
        color: active ? '#fff' : S.muted,
        fontWeight: active ? 700 : 400,
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function HotelLookupClient({ initialRows, loadError }: Props) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterChip>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ---- Error state ----
  if (loadError) {
    return (
      <div style={{
        padding: '24px 20px', background: '#FBEAE7',
        border: `1px solid ${S.danger}`, borderRadius: 8, color: S.danger,
      }}>
        エラー: {loadError}
      </div>
    );
  }

  // ---- Empty state ----
  if (initialRows.length === 0) {
    return (
      <div style={{
        padding: '40px 20px', textAlign: 'center',
        color: S.muted, background: S.surface,
        border: `1px solid ${S.border}`, borderRadius: 8,
      }}>
        ホテルが登録されていません。
      </div>
    );
  }

  // ---- Filtering ----
  const filtered = initialRows.filter((row) => {
    const nameMatch = search.trim() === '' ||
      row.name.toLowerCase().includes(search.trim().toLowerCase());
    if (!nameMatch) return false;
    if (filter === 'ok') return row.record === 'ok';
    if (filter === 'caution') return row.record === 'caution';
    if (filter === 'blocked') return row.record === 'blocked';
    if (filter === 'cardKey') return row.cardKeyRequired;
    if (filter === 'guestCharge') return Boolean(row.guestChargeNote);
    return true;
  });

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const chips: { key: FilterChip; label: string }[] = [
    { key: 'all', label: 'すべて' },
    { key: 'ok', label: '実績〇のみ' },
    { key: 'caution', label: '△注意' },
    { key: 'blocked', label: '✖不可' },
    { key: 'cardKey', label: 'カードキー要' },
    { key: 'guestCharge', label: 'ゲストチャージ有' },
  ];

  return (
    <div>
      {/* Search bar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input
          type="search"
          placeholder="ホテル名で検索（部分一致）…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1, padding: '9px 12px',
            border: `1px solid ${S.border}`, borderRadius: 8,
            fontSize: 14, background: S.surface,
            outline: 'none',
          }}
        />
      </div>

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {chips.map((chip) => (
          <FilterChipButton
            key={chip.key}
            label={chip.label}
            active={filter === chip.key}
            onClick={() => setFilter(chip.key)}
          />
        ))}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: S.muted, margin: '8px 0 4px' }}>
        <span><RecordBadge record="ok" /> 実績あり</span>
        <span><RecordBadge record="caution" /> 要注意</span>
        <span><RecordBadge record="blocked" /> 不可</span>
        <span><Tag label="カードキー" color="#fff" bg="#3f6fb0" /></span>
        <span><Tag label="チャージ" color="#fff" bg={S.warn} /></span>
      </div>

      {/* Empty filtered state */}
      {filtered.length === 0 ? (
        <div style={{
          padding: '32px 20px', textAlign: 'center',
          color: S.muted, background: S.surface,
          border: `1px solid ${S.border}`, borderRadius: 8, marginTop: 8,
        }}>
          該当するホテルが見つかりません。
        </div>
      ) : (
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          background: S.surface, border: `1px solid ${S.border}`,
          borderRadius: 8, overflow: 'hidden',
          marginTop: 8,
        }}>
          <thead>
            <tr>
              <th style={thStyle('')}></th>
              <th style={thStyle('')}>ホテル</th>
              <th style={thStyle('230px')}>迎え方・注意</th>
              <th style={thStyle('')}>住所</th>
              <th style={thStyle('')}>地図</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const isOpen = expanded.has(row.id);
              return (
                <>
                  <tr
                    key={row.id}
                    onClick={() => toggleExpand(row.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={tdStyle()}>
                      <RecordBadge record={row.record} />
                    </td>
                    <td style={tdStyle()}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{row.name}</div>
                      {row.areaName && (
                        <div style={{ fontSize: 11, color: S.muted }}>{row.areaName}</div>
                      )}
                    </td>
                    <td style={{ ...tdStyle(), lineHeight: 1.4 }}>
                      {row.cardKeyRequired && (
                        <Tag label="カードキー" color="#fff" bg="#3f6fb0" />
                      )}
                      {row.guestChargeNote && (
                        <Tag label="チャージ" color="#fff" bg={S.warn} />
                      )}
                      {row.entryNote && (
                        <div style={{
                          marginTop: 4, fontSize: 11, color: '#8a5d16',
                          background: '#FEFBF3',
                          borderLeft: '3px solid #e6d2a8',
                          padding: '3px 7px',
                          borderRadius: '0 4px 4px 0',
                        }}>
                          {row.entryNote}
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdStyle(), fontSize: 11, color: '#4a4f4c', lineHeight: 1.4 }}>
                      {row.address ?? '—'}
                    </td>
                    <td style={tdStyle()}>
                      {row.mapsUrl ? (
                        <a
                          href={row.mapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: S.primary, textDecoration: 'none', fontSize: 11, whiteSpace: 'nowrap' }}
                        >
                          地図 ↗
                        </a>
                      ) : '—'}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${row.id}-detail`}>
                      <td colSpan={5} style={{
                        padding: '10px 16px 14px 36px',
                        background: '#F8FAF9',
                        borderBottom: `1px solid ${S.border}`,
                        fontSize: 12,
                      }}>
                        {row.accessNote && (
                          <div style={{ marginBottom: 8 }}>
                            <span style={{ fontWeight: 700, color: S.muted }}>入場注意・履歴: </span>
                            <span style={{ whiteSpace: 'pre-wrap' }}>{row.accessNote}</span>
                          </div>
                        )}
                        {row.guestChargeNote && (
                          <div>
                            <span style={{ fontWeight: 700, color: S.warn }}>ゲストチャージ: </span>
                            <span style={{ whiteSpace: 'pre-wrap' }}>{row.guestChargeNote}</span>
                          </div>
                        )}
                        {!row.accessNote && !row.guestChargeNote && (
                          <span style={{ color: S.muted }}>詳細情報なし</span>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function thStyle(width: string): React.CSSProperties {
  return {
    fontSize: 11, fontWeight: 700, color: S.muted,
    background: '#F0F2F0', textAlign: 'left',
    padding: 8, borderBottom: `2px solid ${S.border}`,
    whiteSpace: 'nowrap',
    ...(width ? { width } : {}),
  };
}

function tdStyle(): React.CSSProperties {
  return {
    padding: '9px 8px',
    borderBottom: `1px solid ${S.border}`,
    fontSize: 12,
    verticalAlign: 'top',
  };
}
