"use client";

import { useState } from "react";
import Link from "next/link";
import type { NavItem } from "@/lib/public/content";

/**
 * モバイル用ナビ（ハンバーガー）。sm 未満で表示し、横並びナビの代わりに使う。
 * 横並び6項目がモバイル幅を超えてページごと横スクロール（左寄れ）する事故の是正。
 * 文言（aria）は CMS 由来を props で受ける（公開側に日本語リテラルを置かない）。
 */
export function MobileNav({
  items,
  ariaLabel,
}: {
  items: NavItem[];
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="sm:hidden">
      <button
        type="button"
        aria-label={ariaLabel || undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded text-pub-text"
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          {open ? (
            <>
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </>
          ) : (
            <>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </>
          )}
        </svg>
      </button>

      {open && (
        <nav
          aria-label={ariaLabel || undefined}
          className="absolute inset-x-0 top-full border-b border-pub-border bg-pub-bg/98 backdrop-blur"
        >
          <ul className="mx-auto flex max-w-3xl flex-col px-5 py-1">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block border-b border-pub-border/40 py-3 text-pub-subtext transition-colors hover:text-pub-primary"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
