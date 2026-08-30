/**
 * 管理画面レイアウト（spec 12-2）。
 * - 背景 #F6F7F5 / 面 #FFFFFF / 文字 #1C2321 / 主色 #3F7A6B / 罫線 #DFE3DE
 * - 角丸4pxまで。影なし罫線区切り
 * - prefers-reduced-motion 尊重（アニメーションは最小限）
 * - 1280px 想定
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: {
    template: "%s — 管理画面",
    default: "管理画面",
  },
};

const navItems = [
  { href: "/admin/orders", label: "電話受付" },
  { href: "/admin/phone-confirm", label: "電話確認" },
  { href: "/admin/points", label: "ポイント" },
  { href: "/admin/accounting", label: "会計" },
  { href: "/admin/payouts", label: "報酬" },
  { href: "/admin/analytics", label: "集計" },
  { href: "/admin/dispatch-board", label: "配車ボード" },
  { href: "/admin/reservations", label: "予約管理" },
  { href: "/admin/waitlists", label: "キャンセル待ち" },
  { href: "/admin/dispatch", label: "配車テキスト" },
  { href: "/admin/message-templates", label: "送信テンプレート" },
  { href: "/admin/notifications", label: "通知" },
  { href: "/admin/fields", label: "フィールド定義" },
  { href: "/admin/records", label: "レコード" },
  { href: "/admin/settings", label: "サイト設定" },
  { href: "/admin/pages", label: "固定ページ" },
  { href: "/admin/therapists", label: "セラピスト" },
  { href: "/admin/shifts", label: "出勤設定" },
  { href: "/admin/media", label: "メディア" },
  { href: "/admin/preview/home", label: "プレビュー" },
  { href: "/admin/ai", label: "AI" },
] as const;

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-adm-bg text-adm-text">
      {/* ナビゲーションバー */}
      <header className="bg-adm-surface border-b border-adm-border">
        <div className="max-w-[1280px] mx-auto px-6 h-14 flex items-center gap-6">
          <span className="font-semibold text-adm-primary text-sm tracking-wide">
            管理画面
          </span>
          <nav className="flex items-center gap-1" aria-label="管理メニュー">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="px-3 py-1.5 text-sm rounded text-adm-text hover:bg-adm-bg hover:text-adm-primary transition-colors"
                style={{ borderRadius: "4px" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="max-w-[1280px] mx-auto px-6 py-8">
        {children}
      </main>
    </div>
  );
}
