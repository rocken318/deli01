/**
 * 管理画面レイアウト（spec 12-2）。
 * - 背景 #F6F7F5 / 面 #FFFFFF / 文字 #1C2321 / 主色 #3F7A6B / 罫線 #DFE3DE
 * - 角丸4pxまで。影なし罫線区切り
 * - prefers-reduced-motion 尊重（アニメーションは最小限）
 * - 1280px 想定
 */

import type { Metadata } from "next";
import Link from "next/link";
import { getDevSession } from "@/lib/cms/dev-session";
import { signOut } from "@/app/login/actions";
import { AdminNav } from "./_components/admin-nav";

export const metadata: Metadata = {
  title: {
    template: "%s — 管理画面",
    default: "管理画面",
  },
};

const navItems = [
  { href: "/admin/orders", label: "電話受付" },
  { href: "/admin/cti", label: "着信" },
  { href: "/admin/phone-confirm", label: "電話確認" },
  { href: "/admin/points", label: "ポイント" },
  { href: "/admin/accounting", label: "会計" },
  { href: "/admin/payouts", label: "報酬" },
  { href: "/admin/analytics", label: "集計" },
  { href: "/admin/dispatch-board", label: "配車ボード" },
  { href: "/admin/reservations", label: "予約管理" },
  { href: "/admin/history", label: "接客履歴" },
  { href: "/admin/waitlists", label: "キャンセル待ち" },
  { href: "/admin/dispatch", label: "配車テキスト" },
  { href: "/admin/message-templates", label: "送信テンプレート" },
  { href: "/admin/notifications", label: "通知" },
  { href: "/admin/fields", label: "入力項目" },
  { href: "/admin/records", label: "コンテンツ" },
  { href: "/admin/settings", label: "サイト設定" },
  { href: "/admin/pages", label: "固定ページ" },
  { href: "/admin/therapists", label: "セラピスト" },
  { href: "/admin/areas", label: "派遣エリア" },
  { href: "/admin/shifts", label: "出勤設定" },
  { href: "/admin/media", label: "メディア" },
  { href: "/admin/preview/home", label: "プレビュー" },
  { href: "/admin/ai", label: "AI" },
] as const;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getDevSession();
  return (
    <div className="min-h-screen bg-adm-bg text-adm-text [color-scheme:light]">
      {/* ナビゲーションバー */}
      <header className="bg-adm-surface border-b border-adm-border">
        <div className="max-w-[1280px] mx-auto px-6 h-14 flex items-center gap-4">
          <Link
            href="/admin/orders"
            className="font-semibold text-adm-primary text-sm tracking-wide shrink-0"
          >
            管理画面
          </Link>
          <AdminNav items={[...navItems]} />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-adm-text/70">
              {session ? session.role : "未ログイン"}
            </span>
            {session ? (
              <form action={signOut}>
                <button
                  type="submit"
                  className="px-3 py-1.5 border border-adm-border hover:bg-adm-bg"
                  style={{ borderRadius: "4px" }}
                >
                  ログアウト
                </button>
              </form>
            ) : null}
          </div>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="max-w-[1280px] mx-auto px-6 py-8">
        {children}
      </main>
    </div>
  );
}
