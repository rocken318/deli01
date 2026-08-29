import Link from "next/link";
import type { SiteContext } from "@/lib/public/content";

/**
 * 公開ヘッダー（spec 12-1）。屋号・ナビは site_settings 由来。
 * 日本語リテラルは持たない（ctx の値のみ描画）。
 */
export function SiteHeader({ ctx }: { ctx: SiteContext }) {
  return (
    <header className="sticky top-0 z-20 border-b border-pub-border bg-pub-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-3">
        <Link
          href="/"
          className="font-heading text-lg leading-none text-pub-text"
          aria-label={ctx.brandName || undefined}
        >
          {ctx.brandName}
        </Link>
        {ctx.nav.length > 0 && (
          <nav aria-label={ctx.labels["nav_aria"] || undefined}>
            <ul className="flex items-center gap-1 overflow-x-auto text-sm">
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
        )}
      </div>
    </header>
  );
}
