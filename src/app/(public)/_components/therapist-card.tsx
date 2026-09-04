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
  earliestTemplateFuture,
  earliestPending,
  weekdays = "",
  earliestTime = null,
  earliestDateISO = null,
  today = null,
  conditionNote = "",
  workingToday = false,
  todayBadgeLabel = "",
}: {
  card: TherapistCardView;
  detailLabel: string;
  earliestTemplate: string;
  /** 当日以外のとき用テンプレート（CMS labels.earliest_slot_template_future） */
  earliestTemplateFuture?: string | null;
  earliestPending: string;
  /** 曜日ラベル（カンマ区切り） */
  weekdays?: string;
  /** 空き枠エンジンの最短案内時刻 "HH:mm"（無ければ null=placeholder / spec 5-4） */
  earliestTime?: string | null;
  /** 最短枠の営業日 "YYYY-MM-DD"（重大1: 当日以外のとき日付を明記） */
  earliestDateISO?: string | null;
  /** 比較用当日 ISO "YYYY-MM-DD" */
  today?: string | null;
  /** 「〇〇区の場合」等の前提注記（代表エリア概算 / spec 2-3）。無ければ非表示 */
  conditionNote?: string;
  /** 本日（Asia/Tokyo 暦日）出勤しているか。バッジ表示に使う */
  workingToday?: boolean;
  /** 「本日出勤」等のバッジ文言（content レイヤ由来。空なら非表示） */
  todayBadgeLabel?: string;
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
        {workingToday && todayBadgeLabel && (
          <span className="absolute left-2 top-2 z-10 rounded bg-pub-accent px-2 py-0.5 text-xs font-medium text-pub-bg shadow-sm">
            {todayBadgeLabel}
          </span>
        )}
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
        <EarliestSlot
          template={earliestTemplate}
          templateFuture={earliestTemplateFuture}
          placeholder={earliestPending}
          weekdays={weekdays}
          time={earliestTime}
          dateISO={earliestDateISO}
          today={today}
          size="sm"
        />
        {conditionNote && <p className="text-xs text-pub-subtext/80">{conditionNote}</p>}
        {detailLabel && (
          <span className="mt-1 inline-block text-sm text-pub-primary">{detailLabel}</span>
        )}
      </div>
    </Link>
  );
}
