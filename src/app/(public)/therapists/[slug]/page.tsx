import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSiteContext, getPublicTherapistFields, label } from "@/lib/public/content";
import { getPublicTherapist } from "@/lib/public/queries";
import { buildTherapistView } from "@/lib/public/therapist-view";
import { PublicImage } from "../../_components/public-image";
import { EarliestSlot } from "../../_components/earliest-slot";
import { FieldValue } from "./field-value";

/**
 * セラピスト個人ページ（spec 2-2）★主役。
 * - published プロフィールを field_definitions(is_public, sort_order) 駆動で表示
 * - 写真は consent 済み・is_hidden でないもののみ（顔出し可否は media 側で管理）
 * - 構造化データ（Person）を JSON-LD で埋める
 * - 署名要素「最短 HH:MM から案内可能」（値は Phase9 まで placeholder / 金色・等幅・大きく）
 *
 * キャッシュ（spec 2-7）: プロフィール本文・写真は ISR。60秒 revalidate。
 * 空き枠はキャッシュしない方針だが本フェーズは値なしのため該当薄。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [ctx, therapist] = await Promise.all([getSiteContext(), getPublicTherapist(slug)]);
  // 非公開/未同意/退職セラピストは notFound() で not-found ページを描画する（プロフィールは
  // 出さない）。Next 15.5 のストリーミング配下では notFound() が HTTP 200 を返すことがあるため、
  // 検索エンジンに not-found ページを index させないよう noindex を明示する（判断ログ #13）。
  if (!therapist) return { robots: { index: false, follow: false } };
  const catchRaw = therapist.published["catch_copy"];
  const title = typeof catchRaw === "string" && catchRaw ? catchRaw : slug;
  return {
    title,
    description: typeof catchRaw === "string" ? catchRaw : undefined,
    openGraph: { title: ctx.brandName ? `${title} | ${ctx.brandName}` : title },
  };
}

export default async function TherapistDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [ctx, therapist, fields] = await Promise.all([
    getSiteContext(),
    getPublicTherapist(slug),
    getPublicTherapistFields(),
  ]);

  if (!therapist) notFound();

  const view = await buildTherapistView(therapist, fields);

  // JSON-LD (Person / spec 12-1)
  const visiblePhotos = view.photos.filter((p) => p.faceVisibility !== "none");
  const personLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: view.name || view.catchCopy || slug,
    url: `/therapists/${slug}`,
    ...(visiblePhotos.length > 0 ? { image: visiblePhotos.map((p) => p.url) } : {}),
    ...(ctx.brandName
      ? { worksFor: { "@type": "Organization", name: ctx.brandName } }
      : {}),
    ...(view.goodAtTags.length > 0 ? { knowsAbout: view.goodAtTags } : {}),
  };

  const earliestTemplate = label(ctx, "earliest_slot_template");
  const earliestPending = label(ctx, "earliest_slot_pending");
  const bookingHref = ctx.labels["booking_href"] || "/booking";

  return (
    <article className="mx-auto max-w-2xl px-5 py-8">
      <script
        type="application/ld+json"
        // JSON-LD: escape < to prevent script injection via closing tags.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personLd).replace(/</g, "\\u003c") }}
      />

      {/* photos: face_visibility — none=skip, eyes=overlay, face=normal */}
      {visiblePhotos.length > 0 && (
        <div className="mb-6 space-y-3">
          <div className="relative overflow-hidden rounded border border-pub-border bg-pub-surface">
            <PublicImage
              src={visiblePhotos[0]!.url}
              alt={visiblePhotos[0]!.alt}
              width={visiblePhotos[0]!.width ?? 800}
              height={visiblePhotos[0]!.height ?? 800}
              className="aspect-[4/5] w-full object-cover"
              priority
              sizes="(max-width: 768px) 100vw, 672px"
            />
            {visiblePhotos[0]!.faceVisibility === "eyes" && (
              <div className="eye-overlay pointer-events-none absolute inset-0" aria-hidden="true" />
            )}
          </div>
          {visiblePhotos.length > 1 && (
            <ul className="grid grid-cols-3 gap-2">
              {visiblePhotos.slice(1).map((p) => (
                <li key={p.id} className="relative overflow-hidden rounded border border-pub-border">
                  <PublicImage
                    src={p.url}
                    alt={p.alt}
                    width={p.width ?? 400}
                    height={p.height ?? 400}
                    className="aspect-square w-full object-cover"
                    sizes="(max-width: 768px) 33vw, 220px"
                  />
                  {p.faceVisibility === "eyes" && (
                    <div className="eye-overlay pointer-events-none absolute inset-0" aria-hidden="true" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 名前（あれば主見出し）+ キャッチコピー + 署名要素 */}
      <header className="mb-6 space-y-3">
        {view.name ? (
          <>
            <h1 className="font-heading text-2xl leading-snug text-pub-text">{view.name}</h1>
            {view.catchCopy && (
              <p className="text-sm leading-relaxed text-pub-subtext">{view.catchCopy}</p>
            )}
          </>
        ) : (
          view.catchCopy && (
            <h1 className="font-heading text-2xl leading-snug text-pub-text">{view.catchCopy}</h1>
          )
        )}
        {view.goodAtTags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {view.goodAtTags.map((tag) => (
              <li
                key={tag}
                className="rounded border border-pub-border px-2 py-0.5 text-xs text-pub-subtext"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}
        <div className="rounded border border-pub-border bg-pub-surface p-4">
          <EarliestSlot template={earliestTemplate} placeholder={earliestPending} time={null} size="lg" />
        </div>
      </header>

      {/* is_public フィールド（sort_order 順） */}
      {view.fields.length > 0 && (
        <dl className="space-y-5 border-t border-pub-border pt-6">
          {view.fields.map((f) => (
            <div key={f.key}>
              <dt className="mb-1 text-xs uppercase tracking-wide text-pub-subtext">{f.label}</dt>
              <dd className="text-pub-text">
                <FieldValue value={f.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* 予約導線（画面下固定バーと別に本文中にも用意） */}
      {label(ctx, "booking_cta") && (
        <div className="mt-8 text-center">
          <Link
            href={bookingHref}
            className="inline-block rounded bg-pub-primary px-8 py-3 font-medium text-pub-bg hover:opacity-90"
          >
            {label(ctx, "booking_cta")}
          </Link>
        </div>
      )}
    </article>
  );
}
