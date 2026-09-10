/**
 * 管理画面レイアウト（spec 12-2 / 設計 2章）。
 * 上部ハンバーガー → 左サイドバー shell へ。ブランド名は brands から取得。
 */

import type { Metadata } from "next";
import { getDevSession } from "@/lib/cms/dev-session";
import { getClient } from "@/lib/db-client";
import { listBrandsCore } from "@/lib/brands/queries";
import { signOut } from "@/app/login/actions";
import { AdminSidebar } from "./_components/admin-sidebar";

export const metadata: Metadata = {
  title: {
    template: "%s — 管理画面",
    default: "管理画面",
  },
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getDevSession();

  // ブランド名（既定=王様の休日）。取得失敗時は静的フォールバック。
  let brandName = "王様の休日";
  if (session) {
    try {
      const brands = await listBrandsCore(getClient(), session);
      if (brands[0]) brandName = brands[0].name;
    } catch {
      // フォールバックのまま
    }
  }

  return (
    <div className="min-h-screen bg-adm-bg text-adm-text [color-scheme:light] md:flex">
      <AdminSidebar
        brandName={brandName}
        roleLabel={session ? session.role : "未ログイン"}
        signOutAction={signOut}
      />
      <main className="flex-1 min-w-0 px-6 py-8">{children}</main>
    </div>
  );
}
