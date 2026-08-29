import Link from "next/link";
import type { TherapistCardView } from "@/lib/public/therapist-view";
import { PublicImage } from "./public-image";
import { EarliestSlot } from "./earliest-slot";

/**
 * Therapist card (spec 2-3 / 12-1). Photo, catch copy, specialty tags.
 * Signature element "earliest slot" placeholder per card (value from Phase 9).
 * All copy comes from props (content layer). No Japanese literals.
 * face_visibility: face=normal, eyes=eye-overlay, none=silhouette (no person image).
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
  const photo = card.photo;
  const showPhoto = photo !== null && photo.faceVisibility !== "none";
  const eyesOverlay = photo !== null && photo.faceVisibility === "eyes";

  return (
    <Link
      href={`/therapists/${card.slug}`}
      className="group block overflow-hidden rounded border border-pub-border bg-pub-surface transition-colors hover:border-pub-primary focus-visible:border-pub-primary"
      aria-label={card.catchCopy || card.slug}
    >
      <div className="relative aspect-[4/5] w-full overflow-hidden bg-pub-bg">
        {showPhoto ? (
          <>
            <PublicImage
              src={photo.url}
              alt={photo.alt}
              width={photo.width ?? 800}
              height={photo.height ?? 800}
              className="h-full w-full object-cover"
              sizes="(max-width: 640px) 100vw, 320px"
            />
            {eyesOverlay && (
              <div
                className="eye-overlay pointer-events-none absolute inset-0"
                aria-hidden="true"
              />
            )}
          </>
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            role="img"
            aria-label="silhouette"
          >
            <svg
              viewBox="0 0 100 120"
              className="h-1/2 w-1/2 text-pub-border"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="50" cy="35" r="20" />
              <ellipse cx="50" cy="95" rx="35" ry="28" />
            </svg>
          </div>
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
