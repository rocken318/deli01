import Link from "next/link";
import type { SiteContext } from "@/lib/public/content";

/**
 * 公開フッター（spec 12-1 / 13-3）。屋号・電話・SNS・特商法表記は site_settings 由来。
 * 日本語リテラルは持たない。
 */
export function SiteFooter({ ctx }: { ctx: SiteContext }) {
  return (
    <footer className="border-t border-pub-border bg-pub-surface">
      <div className="mx-auto max-w-3xl space-y-4 px-5 py-8 text-sm text-pub-subtext">
        {ctx.brandName && (
          <p className="font-heading text-base text-pub-text">{ctx.brandName}</p>
        )}

        {(ctx.receptionPhone || ctx.receptionHours) && (
          <p className="space-x-2">
            {ctx.receptionPhone && (
              <a
                href={`tel:${ctx.receptionPhone}`}
                className="font-mono text-pub-primary"
              >
                {ctx.receptionPhone}
              </a>
            )}
            {ctx.receptionHours && <span>{ctx.receptionHours}</span>}
          </p>
        )}

        {ctx.social.length > 0 && (
          <ul className="flex flex-wrap gap-3">
            {ctx.social.map((s) => (
              <li key={s.href}>
                <a
                  href={s.href}
                  className="text-pub-subtext underline underline-offset-4 hover:text-pub-primary"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        )}

        {ctx.nav.length > 0 && (
          <nav aria-label={ctx.labels["footer_nav_aria"] || undefined}>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {ctx.nav.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="hover:text-pub-primary">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {ctx.labels["member_link"] && (
          <Link href="/member" className="inline-block text-sm text-pub-primary hover:underline">
            {ctx.labels["member_link"]}
          </Link>
        )}

        {ctx.legalNote && (
          <p className="whitespace-pre-wrap text-xs text-pub-subtext">{ctx.legalNote}</p>
        )}
        {ctx.footerNote && (
          <p className="whitespace-pre-wrap text-xs text-pub-subtext">{ctx.footerNote}</p>
        )}
      </div>
    </footer>
  );
}
