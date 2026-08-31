import Link from "next/link";
import type { SiteContext } from "@/lib/public/content";
import { MobileNav } from "./mobile-nav";

/**
 * 公開ヘッダー（spec 12-1）。屋号・ナビは site_settings 由来。
 * 日本語リテラルは持たない（ctx の値のみ描画）。
 * モバイル（sm 未満）はハンバーガー、sm 以上は横並びナビ。
 * ＝横並び6項目がモバイル幅を超えてページごと横スクロール（左寄れ）する事故の是正。
 */
export function SiteHeader({ ctx }: { ctx: SiteContext }) {
  return (
    <header className="sticky top-0 z-20 border-b border-pub-border bg-pub-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-3">
        <Link
          href="/"
          className="min-w-0 shrink truncate font-heading text-lg leading-none text-pub-text"
          aria-label={ctx.brandName || undefined}
        >
          {ctx.brandName}
        </Link>
        {ctx.nav.length > 0 && (
          <>
            {/* デスクトップ: 横並び */}
            <nav
              aria-label={ctx.labels["nav_aria"] || undefined}
              className="hidden sm:block"
            >
              <ul className="flex items-center gap-1 text-sm">
                {ctx.nav.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="block whitespace-nowrap rounded px-2.5 py-1.5 text-pub-subtext transition-colors hover:text-pub-primary focus-visible:text-pub-primary"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            {/* モバイル: ハンバーガー */}
            <MobileNav
              items={ctx.nav}
              ariaLabel={ctx.labels["nav_aria"] || ""}
            />
          </>
        )}
      </div>
    </header>
  );
}
