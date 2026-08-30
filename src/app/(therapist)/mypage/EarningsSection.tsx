import { format, startOfMonth } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { getMyEarnings } from '@/lib/payout/actions';
import type { MyEarnings } from '@/lib/payout/actions';

const APP_TZ = 'Asia/Tokyo';

// Design tokens (spec 12-2)
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

type PayoutCategory =
  | 'course'
  | 'option'
  | 'nomination'
  | 'transport'
  | 'late_night'
  | 'cancel_fee'
  | 'adjustment';

const CATEGORY_LABELS: Record<PayoutCategory, string> = {
  course: 'コース',
  option: 'オプション',
  nomination: '指名料',
  transport: '交通費',
  late_night: '深夜加算',
  cancel_fee: 'キャンセル料',
  adjustment: '調整',
};

const STATUS_LABELS: Record<'open' | 'closed' | 'paid', string> = {
  open: '未締め',
  closed: '締め済み',
  paid: '支払済み',
};

const STATUS_COLORS: Record<'open' | 'closed' | 'paid', string> = {
  open: T.muted,
  closed: T.caution,
  paid: T.primary,
};

function yen(n: number): string {
  return `¥${n.toLocaleString()}`;
}

function formatPeriod(start: string, end: string): string {
  // start: YYYY-MM-DD, end: YYYY-MM-DD
  const s = start.replace(/-/g, '/');
  // show end as MM/DD when same year
  const [sy] = start.split('-');
  const [ey, em, ed] = end.split('-');
  const endLabel = sy === ey ? `${em}/${ed}` : end.replace(/-/g, '/');
  return `${s}〜${endLabel}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionDivider() {
  return (
    <div style={{ borderTop: `1px solid ${T.border}`, margin: '0 -12px' }} />
  );
}

function EarningsContent({ data }: { data: MyEarnings }) {
  const { todayTotal, monthToDateTotal, confirmedNetTotal, range, payouts } = data;
  const allZero =
    todayTotal === 0 && monthToDateTotal === 0 && confirmedNetTotal === 0;

  // Filter categories with non-zero amounts
  const nonZeroCategories = (Object.keys(range.byCategory) as PayoutCategory[]).filter(
    (cat) => range.byCategory[cat] !== 0,
  );

  return (
    <div
      style={{
        background: T.bg,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        overflow: 'hidden',
      }}
    >
      {/* 今日の稼ぎ */}
      <div style={{ padding: '16px 12px 14px' }}>
        <p style={{ fontSize: '12px', color: T.muted, marginBottom: '4px' }}>今日の稼ぎ</p>
        <p
          style={{
            fontSize: '28px',
            fontWeight: 700,
            color: T.primary,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.5px',
          }}
        >
          {yen(todayTotal)}
        </p>
        {allZero && (
          <p style={{ fontSize: '12px', color: T.muted, marginTop: '6px' }}>
            施術完了で反映されます
          </p>
        )}
      </div>

      <SectionDivider />

      {/* 今月見込み・確定額 */}
      <div style={{ padding: '12px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingBottom: '8px',
          }}
        >
          <span style={{ fontSize: '13px', color: T.text }}>今月の見込み</span>
          <span
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: T.text,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {yen(monthToDateTotal)}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '13px', color: T.muted }}>確定額（締め済み）</span>
          <span
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: T.muted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {yen(confirmedNetTotal)}
          </span>
        </div>
      </div>

      {/* 今月の内訳（非ゼロカテゴリのみ） */}
      {nonZeroCategories.length > 0 && (
        <>
          <SectionDivider />
          <div style={{ padding: '12px' }}>
            <p
              style={{
                fontSize: '12px',
                color: T.muted,
                marginBottom: '8px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              今月の内訳
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {nonZeroCategories.map((cat) => (
                <div
                  key={cat}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: '13px', color: T.text }}>
                    {CATEGORY_LABELS[cat]}
                  </span>
                  <span
                    style={{
                      fontSize: '13px',
                      color: T.text,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {yen(range.byCategory[cat])}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* 支払履歴 */}
      {payouts.length > 0 && (
        <>
          <SectionDivider />
          <div style={{ padding: '12px' }}>
            <p
              style={{
                fontSize: '12px',
                color: T.muted,
                marginBottom: '8px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              支払履歴
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {payouts.map((p) => (
                <div
                  key={p.id}
                  style={{
                    padding: '10px',
                    background: '#F6F7F5',
                    borderRadius: T.radius,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      marginBottom: '4px',
                    }}
                  >
                    <span style={{ fontSize: '12px', color: T.muted }}>
                      {formatPeriod(p.periodStart, p.periodEnd)}
                    </span>
                    <span
                      style={{
                        fontSize: '14px',
                        fontWeight: 700,
                        color: T.text,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {yen(p.net)}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: STATUS_COLORS[p.status],
                      }}
                    >
                      {STATUS_LABELS[p.status]}
                    </span>
                    {p.deductions > 0 && (
                      <span style={{ fontSize: '11px', color: T.muted }}>
                        控除 {yen(p.deductions)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main server component
// ---------------------------------------------------------------------------

export default async function EarningsSection({ asSlug }: { asSlug?: string }) {
  const now = new Date();
  const todayISO = format(toZonedTime(now, APP_TZ), 'yyyy-MM-dd');
  const monthStartISO = format(startOfMonth(toZonedTime(now, APP_TZ)), 'yyyy-MM-dd');

  const result = await getMyEarnings({ from: monthStartISO, to: todayISO, asSlug });

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
        稼ぎ
      </h2>

      {!result.ok || result.data == null ? (
        <div
          style={{
            background: T.bg,
            border: `1px solid ${T.border}`,
            borderRadius: T.radius,
            padding: '16px 12px',
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: '13px', color: T.muted }}>報酬情報の取得に失敗しました</p>
        </div>
      ) : (
        <EarningsContent data={result.data} />
      )}
    </div>
  );
}
