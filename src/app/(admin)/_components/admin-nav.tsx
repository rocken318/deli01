"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface AdminNavItem {
  href: string;
  label: string;
}

/**
 * 管理画面のナビ（ハンバーガー・ドロップダウン）。
 * 22項目の横並びが 1280px に収まらず崩壊していたため、常時ハンバーガーに畳む。
 * 管理側なので日本語直書き可（公開側の直書き禁止は対象外）。
 */
export function AdminNav({ items }: { items: AdminNavItem[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const current = items.find((i) => pathname === i.href || pathname.startsWith(i.href + "/"));

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="メニュー"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded border border-adm-border px-3 py-1.5 text-sm text-adm-text hover:bg-adm-bg"
        style={{ borderRadius: "4px" }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
        <span className="max-w-[8rem] truncate">{current?.label ?? "メニュー"}</span>
      </button>

      {open && (
        <>
          {/* クリック外で閉じる用の透明オーバーレイ */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <nav
            aria-label="管理メニュー"
            className="absolute left-0 top-full z-40 mt-1 max-h-[70vh] w-64 overflow-y-auto rounded border border-adm-border bg-adm-surface shadow"
            style={{ borderRadius: "4px" }}
          >
            <ul className="py-1">
              {items.map((item) => {
                const active = item === current;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={`block px-3 py-2 text-sm hover:bg-adm-bg ${
                        active ? "text-adm-primary font-medium" : "text-adm-text"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </>
      )}
    </div>
  );
}
