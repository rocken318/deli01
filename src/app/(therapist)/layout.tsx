/**
 * セラピスト用レイアウト（スマホ専用 / spec 7-4・12-2）。
 *
 * - 管理ナビなし（admin レイアウトとは独立）
 * - 背景 #F6F7F5、文字 #1C2321（spec 12-2 系）
 * - 最大幅 480px（375px 基準。タブレットでも崩れないよう上限を設ける）
 * - prefers-reduced-motion 尊重
 */

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: {
    template: '%s — マイページ',
    default: 'マイページ',
  },
};

export default function TherapistLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-h-screen"
      style={{ background: '#F6F7F5', color: '#1C2321' }}
    >
      <div className="max-w-[480px] mx-auto">
        {children}
      </div>
    </div>
  );
}
