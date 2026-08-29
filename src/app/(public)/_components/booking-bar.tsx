import Link from "next/link";

/**
 * 画面下に固定する予約バー（spec 12-1「予約ボタンは画面下に固定」）。
 * ラベル・電話は content レイヤ（CMS）由来。日本語リテラルを持たない。
 */
export function BookingBar({
  href,
  label,
  phone,
}: {
  href: string;
  label: string;
  phone: string;
}) {
  // ラベルが未設定なら描画しない（日本語のフォールバックを埋め込まないため）
  if (!label && !phone) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-pub-border bg-pub-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-3">
        {phone && (
          <a
            href={`tel:${phone}`}
            className="shrink-0 rounded border border-pub-border px-3 py-2.5 font-mono text-sm text-pub-primary"
            aria-label={phone}
          >
            {phone}
          </a>
        )}
        {label && (
          <Link
            href={href}
            className="flex-1 rounded bg-pub-primary px-4 py-3 text-center font-medium text-pub-bg transition-opacity hover:opacity-90 focus-visible:opacity-90"
          >
            {label}
          </Link>
        )}
      </div>
    </div>
  );
}
