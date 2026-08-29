import Link from "next/link";

/**
 * 空状態（spec 12-3「空の画面には次の一手を置く」）。
 * 文言は呼び出し側が content レイヤ（CMS）から渡す。日本語リテラルを持たない。
 */
export function EmptyState({
  title,
  body,
  actionLabel,
  actionHref,
}: {
  title: string;
  body?: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      {title && <p className="font-heading text-lg text-pub-text">{title}</p>}
      {body && <p className="mt-2 text-sm text-pub-subtext">{body}</p>}
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          className="mt-6 inline-block rounded bg-pub-primary px-6 py-2.5 font-medium text-pub-bg hover:opacity-90"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
