import Link from "next/link";
import type { TherapistCardView } from "@/lib/public/therapist-view";
import { PublicImage } from "./public-image";
import { EarliestSlot } from "./earliest-slot";

/**
 * セラピストカード（spec 2-3 / 12-1）。写真・キャッチ・得意な施術タグ。
 * 署名要素「最短 HH:MM から案内可能」の枠を各カードに置く（値は Phase9 まで placeholder）。
 * 文言はすべて props（content レイヤ由来）。日本語リテラルを持たない。
 */
export function TherapistCard({
  card,
  detailLabel,
  earliestTemplate,
  earliestPending,
}: {
  card: TherapistCardView;
  detailLabel: string;
  earliestTemplate: string;
  earliestPending: string;
}) {
  return (
    <Link
      href={`/therapists/${card.slug}`}
      className="group block overflow-hidden rounded border border-pub-border bg-pub-surface transition-colors hover:border-pub-primary focus-visible:border-pub-primary"
      aria-label={card.catchCopy || card.slug}
    >
      <div className="relative aspect-[4/5] w-full overflow-hidden bg-pub-bg">
        {card.photo && (
          <PublicImage
            src={card.photo.url}
            alt={card.photo.alt}
            width={card.photo.width ?? 800}
            height={card.photo.height ?? 800}
            className="h-full w-full object-cover"
            sizes="(max-width: 640px) 100vw, 320px"
          />
        )}
      </div>
      <div className="space-y-2 p-4">
        {card.catchCopy && (
          <p className="font-heading text-base leading-snug text-pub-text">{card.catchCopy}</p>
        )}
        {card.goodAtTags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {card.goodAtTags.map((tag) => (
              <li
                key={tag}
                className="rounded border border-pub-border px-2 py-0.5 text-xs text-pub-subtext"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}
        <EarliestSlot template={earliestTemplate} placeholder={earliestPending} time={null} size="sm" />
        {detailLabel && (
          <span className="mt-1 inline-block text-sm text-pub-primary">{detailLabel}</span>
        )}
      </div>
    </Link>
  );
}
