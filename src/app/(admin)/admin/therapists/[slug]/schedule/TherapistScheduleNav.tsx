'use client';

/**
 * セラピスト当日状況ページの日付ナビゲーション（クライアントコンポーネント）。
 * 日付入力・前日/翌日・「当日」ボタン。dispatch-board のナビに倣う。
 */

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

interface Props {
  slug: string;
  dateISO: string;
  todayISO: string;
  prevDate: string;
  nextDate: string;
}

export function TherapistScheduleNav({ slug, dateISO, todayISO, prevDate, nextDate }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function navigate(date: string) {
    startTransition(() => {
      router.push(`/admin/therapists/${slug}/schedule?date=${date}`);
    });
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button
        onClick={() => navigate(prevDate)}
        disabled={isPending}
        className="px-3 py-1.5 border border-adm-border text-adm-text text-sm hover:bg-adm-bg disabled:opacity-50 transition-colors"
        style={{ borderRadius: '4px' }}
        aria-label="前日"
      >
        ← 前日
      </button>

      <input
        type="date"
        defaultValue={dateISO}
        key={dateISO}
        onChange={(e) => {
          if (e.target.value) navigate(e.target.value);
        }}
        disabled={isPending}
        className="px-3 py-1.5 border border-adm-border text-adm-text text-sm bg-adm-surface disabled:opacity-50"
        style={{ borderRadius: '4px' }}
        aria-label="日付選択"
      />

      <button
        onClick={() => navigate(nextDate)}
        disabled={isPending}
        className="px-3 py-1.5 border border-adm-border text-adm-text text-sm hover:bg-adm-bg disabled:opacity-50 transition-colors"
        style={{ borderRadius: '4px' }}
        aria-label="翌日"
      >
        翌日 →
      </button>

      {dateISO !== todayISO && (
        <button
          onClick={() => navigate(todayISO)}
          disabled={isPending}
          className="px-3 py-1.5 text-sm disabled:opacity-50"
          style={{
            borderRadius: '4px',
            color: '#3F7A6B',
            textDecoration: 'underline',
          }}
        >
          当日
        </button>
      )}

      {isPending && (
        <span className="text-xs text-adm-muted">読込中...</span>
      )}
    </div>
  );
}
