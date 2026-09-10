"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_NAV_GROUPS, findActiveNavItem } from "./admin-nav-model";

/**
 * 管理コンソールの左サイドバー（設計 2章 / nav-shell モック準拠）。
 * - 上: ブランド名（王様の休日）
 * - 主要ピン留め + グループ分け（admin-nav-model）
 * - 狭幅/モバイルはハンバーガーで開閉（md 未満は初期折りたたみ）
 * - フッタ: ロール表示 + ログアウト（server action を props で受ける）
 * 管理側なので日本語直書き可。色は nav-shell モックの配色（インライン）。
 */
export function AdminSidebar({
  brandName,
  roleLabel,
  signOutAction,
}: {
  brandName: string;
  roleLabel: string;
  signOutAction: () => void | Promise<void>;
}) {
  const pathname = usePathname();
  const active = findActiveNavItem(ADMIN_NAV_GROUPS, pathname);
  const [open, setOpen] = useState(false);

  const NAV_BG = "#1E2A27";
  const TEXT = "#dfe6e3";
  const MUTED = "#7f948e";
  const PRIMARY = "#3F7A6B";

  return (
    <>
      {/* モバイル用トグル（md 以上では非表示） */}
      <button
        type="button"
        aria-label="メニュー"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="md:hidden fixed top-3 left-3 z-50 rounded px-3 py-2"
        style={{ background: NAV_BG, color: TEXT }}
      >
        ☰
      </button>

      <aside
        aria-label="管理メニュー"
        className={`${open ? "flex" : "hidden"} md:flex fixed md:sticky top-0 left-0 z-40 h-screen w-[210px] flex-col shrink-0 overflow-y-auto`}
        style={{ background: NAV_BG, color: TEXT, padding: "12px 10px" }}
      >
        <div style={{ padding: "6px 8px 12px", borderBottom: "1px solid rgba(255,255,255,.1)", marginBottom: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{brandName}</div>
          <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>配車・受付コンソール</div>
        </div>

        <nav className="flex-1">
          {ADMIN_NAV_GROUPS.map((group) => (
            <div key={group.label} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: ".06em", padding: "8px 8px 4px" }}>
                {group.label}
              </div>
              {group.items.map((item) => {
                const isActive = active?.href === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    style={{
                      display: "block",
                      padding: "8px 10px",
                      borderRadius: 8,
                      marginBottom: 2,
                      fontSize: 13,
                      fontWeight: isActive ? 700 : 400,
                      color: isActive ? "#fff" : TEXT,
                      background: isActive ? PRIMARY : "transparent",
                      textDecoration: "none",
                    }}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div style={{ marginTop: "auto", paddingTop: 8, borderTop: "1px solid rgba(255,255,255,.1)", fontSize: 12, color: MUTED }}>
          <a href="/" target="_blank" rel="noopener noreferrer" style={{ color: TEXT, display: "block", padding: "6px 8px" }}>
            表ページを見る ↗
          </a>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px" }}>
            <span>{roleLabel}</span>
            <form action={signOutAction}>
              <button type="submit" style={{ color: TEXT, background: "none", border: "none", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
                ログアウト
              </button>
            </form>
          </div>
        </div>
      </aside>
    </>
  );
}
