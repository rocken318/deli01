import type { Metadata } from "next";
import { Shippori_Mincho_B1, Noto_Sans_JP, IBM_Plex_Mono } from "next/font/google";
import { getSiteContext, label } from "@/lib/public/content";
import { SiteHeader } from "./_components/site-header";
import { SiteFooter } from "./_components/site-footer";
import { BookingBar } from "./_components/booking-bar";

/**
 * 公開レイアウト（spec 12-1）。暗い画面が既定・モバイルファースト（375px 先行）。
 * - 見出し Shippori Mincho B1 / 本文 Noto Sans JP / 時刻金額 IBM Plex Mono（next/font）
 * - ナビ/フッターは site_settings 由来。予約ボタンは画面下に固定
 * - 文言は content レイヤ（CMS/用語辞書）経由。ここに日本語リテラルを置かない
 */

const heading = Shippori_Mincho_B1({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-heading",
  display: "swap",
});

const body = Noto_Sans_JP({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await getSiteContext();
  return {
    title: {
      template: ctx.brandName ? `%s | ${ctx.brandName}` : "%s",
      default: ctx.brandName || " ",
    },
    description: ctx.footerNote || undefined,
  };
}

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getSiteContext();
  const bookingHref = ctx.labels["booking_href"] || "/booking";
  const bookingLabel = label(ctx, "booking_cta");

  return (
    <div
      className={`${heading.variable} ${body.variable} ${mono.variable} flex min-h-screen flex-col bg-pub-bg text-pub-text`}
    >
      <SiteHeader ctx={ctx} />
      {/* 画面下固定の予約バー分の余白を確保 */}
      <main className="flex-1 pb-24">{children}</main>
      <SiteFooter ctx={ctx} />
      <BookingBar href={bookingHref} label={bookingLabel} phone={ctx.receptionPhone} />
    </div>
  );
}
