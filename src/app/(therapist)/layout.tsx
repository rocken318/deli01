/**
 * セラピスト用レイアウト（スマホ専用 / spec 7-4・12-2）。
 *
 * - 管理ナビなし（admin レイアウトとは独立）
 * - 背景 #F6F7F5、文字 #1C2321（spec 12-2 系）
 * - 最大幅 480px（375px 基準。タブレットでも崩れないよう上限を設ける）
 * - prefers-reduced-motion 尊重
 */

import type { Metadata } from 'next';
import { signOut } from '@/app/login/actions';
import { getTherapistDevSession } from '@/lib/cms/dev-session';

export const metadata: Metadata = {
  title: {
    template: '%s — マイページ',
    default: 'マイページ',
  },
};

export default async function TherapistLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getTherapistDevSession();
  return (
    <div
      className="min-h-screen"
      style={{ background: '#F6F7F5', color: '#1C2321' }}
    >
      <div className="max-w-[480px] mx-auto">
        {session ? (
          <div className="flex justify-end px-4 pt-3">
            <form action={signOut}>
              <button
                type="submit"
                className="text-sm px-3 py-1.5 border"
                style={{ borderRadius: '4px', borderColor: '#DFE3DE' }}
              >
                ログアウト
              </button>
            </form>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
