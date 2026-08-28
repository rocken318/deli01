import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    // メディアは Supabase Storage / next/image で配信（spec 3-7）。
    // 開発中の許可ホストは後続フェーズで追加する。
    remotePatterns: [],
  },
};

export default nextConfig;
