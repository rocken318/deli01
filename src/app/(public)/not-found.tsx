import Link from "next/link";

/**
 * 公開側の 404（notFound() の明示ハンドラ）。
 * これが無いと Next.js 15 は既定 not-found を 200 で返す場合がある。
 * 直書き日本語を置かない（記号 + 英語 aria-label / spec 3-6）。
 */
export default function PublicNotFound() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-5 px-5 py-16 text-center">
      <p className="font-mono text-5xl text-pub-primary">404</p>
      <Link
        href="/"
        aria-label="Home"
        className="rounded border border-pub-border px-6 py-2 text-pub-text hover:border-pub-primary hover:text-pub-primary"
      >
        ↩
      </Link>
    </div>
  );
}
