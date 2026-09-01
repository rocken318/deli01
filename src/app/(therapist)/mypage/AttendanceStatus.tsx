import { formatInTimeZone } from 'date-fns-tz';

/**
 * 出退勤ステータス（表示専用 / フェーズD）。
 * 打刻自体は事務所のQRから（/mypage/punch?t=…）行う。ここは今日の実績を見るだけ。
 */

const TZ = 'Asia/Tokyo';
const hm = (iso: string) => formatInTimeZone(new Date(iso), TZ, 'HH:mm');

const T = {
  bg: '#FFFFFF',
  text: '#1C2321',
  border: '#DFE3DE',
  muted: '#6B7776',
  in: '#3F7A6B',
  out: '#5b625f',
  radius: '4px',
} as const;

export default function AttendanceStatus({
  clockInAt,
  clockOutAt,
}: {
  clockInAt: string | null;
  clockOutAt: string | null;
}) {
  return (
    <div
      style={{
        background: T.bg,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        padding: '12px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>本日の出退勤</span>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: T.muted }}>出勤</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: clockInAt ? T.in : T.muted, fontVariantNumeric: 'tabular-nums' }}>
              {clockInAt ? hm(clockInAt) : '—'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: T.muted }}>退勤</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: clockOutAt ? T.out : T.muted, fontVariantNumeric: 'tabular-nums' }}>
              {clockOutAt ? hm(clockOutAt) : '—'}
            </div>
          </div>
        </div>
      </div>
      {!clockInAt && (
        <p style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>
          未打刻です。事務所のQRコードを読み取って出勤を記録してください。
        </p>
      )}
    </div>
  );
}
