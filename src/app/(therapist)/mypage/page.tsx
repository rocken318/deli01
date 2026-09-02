import type { Metadata } from 'next';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  getMyTimeline,
  getMyAttendanceToday,
} from '@/lib/dispatch-board/therapist-portal-actions';
import TimelineView from './TimelineView';
import EmergencyButton from './EmergencyButton';
import EarningsSection from './EarningsSection';
import ScheduleSection from './ScheduleSection';
import ShiftSelfRegister from './ShiftSelfRegister';
import HandoverSection from './HandoverSection';
import AttendanceStatus from './AttendanceStatus';

export const metadata: Metadata = {
  title: '今日の予定',
};

export const dynamic = 'force-dynamic';

const APP_TZ = 'Asia/Tokyo';

/**
 * セラピスト用マイページ（spec 7-4）。
 *
 * dev なりすまし: ADMIN_DEV_SESSION=1 のとき ?as=<slug> でセラピストを選択。
 * 本番では getTherapistDevSession が null を返すため「認証が必要です」になる。
 * TODO(live Auth): live SessionProvider に差し替えたとき asSlug を除去する。
 *
 * 実装済み: 今日の予定 / 出勤登録(B) / 出勤カレンダー・予約(A1) / 今月の稼ぎ(18) /
 *          出退勤ステータス(D・打刻は事務所QR /mypage/punch) / 引き継ぎメモ(16) / 緊急連絡.
 * 先送り: 打診返答(後続) / 通知受信(20) / 個人情報(C・機微) / 自写真差替(H).
 */
export default async function MyPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string; date?: string }>;
}) {
  const params = await searchParams;
  const todayISO = format(toZonedTime(new Date(), APP_TZ), 'yyyy-MM-dd');
  const asSlug = params.as;

  // 日付指定（dev 用: ?date=YYYY-MM-DD で翌日以降も確認可）
  const dateISO =
    typeof params.date === 'string' &&
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(params.date)
      ? params.date
      : todayISO;

  const [result, attendance] = await Promise.all([
    getMyTimeline(dateISO, asSlug),
    getMyAttendanceToday(asSlug),
  ]);

  // 現在の予約（最初の未完了）を緊急ボタン・引き継ぎメモへ渡す
  const firstActive = result.ok
    ? (result.data ?? []).find((item) => item.status !== 'done')
    : undefined;
  const firstActiveId = firstActive?.reservationId;

  const displayDate = format(
    toZonedTime(new Date(dateISO + 'T12:00:00'), APP_TZ),
    'M月d日（eee）',
    { locale: undefined },
  );

  return (
    <div className="min-h-screen" style={{ background: '#F6F7F5' }}>
      {/* ヘッダ */}
      <header
        className="sticky top-0 z-10 px-4 py-3 flex items-center justify-between"
        style={{
          background: '#FFFFFF',
          borderBottom: '1px solid #DFE3DE',
        }}
      >
        <h1 className="font-semibold text-base" style={{ color: '#1C2321' }}>
          マイページ
        </h1>
        <span className="text-sm" style={{ color: '#6B7776' }}>
          {displayDate}
        </span>
      </header>

      <main className="px-4 py-4 space-y-4">
        {/* 認証エラー */}
        {!result.ok && result.error?.includes('認証') && (
          <div
            className="rounded p-4 text-center"
            style={{
              background: '#FFFFFF',
              border: '1px solid #DFE3DE',
              borderRadius: '4px',
            }}
          >
            <p className="text-sm font-semibold mb-1" style={{ color: '#1C2321' }}>
              セラピストとしてログインが必要です
            </p>
            {process.env.NODE_ENV === 'development' && (
              <p className="text-xs" style={{ color: '#6B7776' }}>
                開発環境: ?as=aoi または ?as=ren を URL に追加してください
              </p>
            )}
          </div>
        )}

        {/* 取得エラー（認証以外） */}
        {!result.ok && !result.error?.includes('認証') && (
          <div
            role="alert"
            className="rounded p-4"
            style={{
              background: '#fff0f0',
              border: '1px solid #B4453C',
              borderRadius: '4px',
            }}
          >
            <p className="text-sm font-semibold" style={{ color: '#B4453C' }}>
              予定の取得に失敗しました
            </p>
            <p className="text-xs mt-1" style={{ color: '#1C2321' }}>
              {result.error}
            </p>
          </div>
        )}

        {/* タイムライン（成功時）。当日のみ操作可・過去/未来は読み取り専用 */}
        {result.ok && (
          <section aria-label={dateISO === todayISO ? '今日の予定' : 'この日の予定'}>
            <TimelineView
              initialItems={result.data ?? []}
              asSlug={asSlug}
              isToday={dateISO === todayISO}
            />
          </section>
        )}

        {/* 出退勤ステータス（D: 打刻は事務所QR /mypage/punch） */}
        <section aria-label="出退勤">
          <AttendanceStatus
            clockInAt={attendance.ok ? (attendance.data?.clockInAt ?? null) : null}
            clockOutAt={attendance.ok ? (attendance.data?.clockOutAt ?? null) : null}
          />
        </section>

        {/* 引き継ぎメモ（フェーズ16・アクティブ予約がある時） */}
        {firstActive && (
          <section aria-label="引き継ぎメモ">
            <HandoverSection
              reservationId={firstActive.reservationId}
              status={firstActive.status}
              asSlug={asSlug}
            />
          </section>
        )}

        {/* 出勤登録（B: キャスト自入力） */}
        <section aria-label="出勤登録">
          <ShiftSelfRegister asSlug={asSlug} />
        </section>

        {/* 出勤カレンダー・予約一覧（A1） */}
        <section aria-label="出勤カレンダーと予約一覧">
          <ScheduleSection asSlug={asSlug} />
        </section>

        {/* 稼ぎ（フェーズ18） */}
        <section aria-label="今月の稼ぎ">
          <EarningsSection asSlug={asSlug} />
        </section>

        {/* 緊急連絡ボタン（常時表示） */}
        <section aria-label="緊急連絡">
          <EmergencyButton
            reservationId={firstActiveId}
            asSlug={asSlug}
          />
        </section>

        {/* 日付ナビ（dev 用: 前日・翌日） */}
        {process.env.NODE_ENV === 'development' && (
          <nav className="flex gap-2 text-xs" aria-label="日付切替（開発用）">
            {[
              { label: '前日', offset: -1 },
              { label: '今日', offset: 0, isToday: true },
              { label: '翌日', offset: 1 },
            ].map(({ label, offset, isToday }) => {
              const targetDate = isToday
                ? todayISO
                : format(
                    new Date(
                      new Date(dateISO + 'T12:00:00').getTime() +
                        offset * 86400000,
                    ),
                    'yyyy-MM-dd',
                  );
              const params = new URLSearchParams();
              if (asSlug) params.set('as', asSlug);
              if (!isToday || targetDate !== todayISO)
                params.set('date', targetDate);
              return (
                <a
                  key={label}
                  href={`/mypage${params.toString() ? '?' + params.toString() : ''}`}
                  className="flex-1 text-center py-2 rounded border"
                  style={{
                    borderColor: '#DFE3DE',
                    color: '#6B7776',
                    borderRadius: '4px',
                    background: '#FFFFFF',
                  }}
                >
                  {label}
                </a>
              );
            })}
          </nav>
        )}
      </main>
    </div>
  );
}
