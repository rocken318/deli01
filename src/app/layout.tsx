import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // 屋号・説明は後続フェーズで CMS（site_settings）から差し込む。ここは初期値。
  title: "出張リラクゼーション予約",
  description: "移動を挟んで案内できる時間だけをお見せします。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
