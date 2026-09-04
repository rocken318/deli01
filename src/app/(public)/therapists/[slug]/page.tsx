import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSiteContext, getPublicTherapistFields, label } from "@/lib/public/content";
import { getPublicTherapist } from "@/lib/public/queries";
import { buildTherapistView } from "@/lib/public/therapist-view";
import { earliestSlotForTherapist } from "@/lib/availability/earliest";
import {
  getTherapistSlots,
  getPublicTherapistId,
  listPublicCourses,
  listPublicOptions,
} from "@/lib/availability/public-slots";
import { operatingDayISO } from "@/domain/availability";
import { PublicImage } from "../../_components/public-image";
import { EarliestSlot } from "../../_components/earliest-slot";
import { FunnelPing } from "../../_components/funnel-ping";
import { AvailabilityPanel } from "./availability-panel";
import type { AvailabilityLabels } from "./availability-panel";
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
  const [ctx, therapist, fields, earliest, therapistId, courses] = await Promise.all([
    getSiteContext(),
    getPublicTherapist(slug),
    getPublicTherapistFields(),
    // 最短案内時間（spec 5-4）。失敗しても公開ページは落とさない
    earliestSlotForTherapist(slug).catch(() => null),
    getPublicTherapistId(slug).catch(() => null),
    listPublicCourses().catch(() => []),
  ]);

  if (!therapist) notFound();

  const view = await buildTherapistView(therapist, fields);

  // コース/オプション + 初期空き枠（今日・代表エリア概算）。失敗しても本文は落とさない。
  // 変更時の再計算は Server Action（都度計算・キャッシュしない / spec 2-7）。
  const [options, initialSlots] = await Promise.all([
    listPublicOptions(therapistId).catch(() => []),
    getTherapistSlots({ slug, courseId: courses[0]?.id ?? null }).catch(() => null),
  ]);

  const today = operatingDayISO(new Date());

  const availabilityLabels: AvailabilityLabels = {
    areaHeading: label(ctx, "slots_area_heading"),
    areaAll: label(ctx, "slots_area_all"),
    courseHeading: label(ctx, "slots_course_heading"),
    optionHeading: label(ctx, "slots_option_heading"),
    slotsHeading: label(ctx, "slots_heading"),
    conditionTemplate: label(ctx, "slots_condition_template"),
    assumedNote: label(ctx, "slots_assumed_note"),
    emptyTitle: label(ctx, "slots_empty_title"),
    emptyBody: label(ctx, "slots_empty_body"),
    loading: label(ctx, "slots_loading"),
    error: label(ctx, "slots_error"),
    slotAria: label(ctx, "slots_select_aria"),
    dateNote: label(ctx, "slots_date_note"),
    dateTodayLabel: label(ctx, "slots_date_today"),
    weekdays: label(ctx, "schedule_weekdays"),
    dateHeading: label(ctx, "slots_date_heading"),
    dateSoonest: label(ctx, "slots_date_soonest"),
    timelineBooked: label(ctx, "slots_timeline_booked"),
  };

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
  const bookingBase = ctx.labels["booking_href"] || "/booking";
  // 個人ページからの予約導線はセラピストを事前選択して渡す（フェーズ11 注文フロー）
  const bookingHref = `${bookingBase}?t=${encodeURIComponent(slug)}`;

  return (
    <article className="mx-auto max-w-2xl px-5 py-8">
      {/* ファネル計測: セラピスト閲覧（付録B-2。描画なし） */}
      <FunnelPing step="view_therapist" slug={slug} />
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
          {/* time は空き枠エンジンの最短案内（spec 5-4）。枠なしは placeholder のまま。
              代表エリア概算（assumed=true）のときは「〇〇区の場合」を明記（reviewer R-4）。
              重大1: 当日以外の枠は日付を明記して誤認を防ぐ。 */}
          <EarliestSlot
            template={earliestTemplate}
            templateFuture={label(ctx, "earliest_slot_template_future")}
            placeholder={earliestPending}
            weekdays={label(ctx, "schedule_weekdays")}
            time={earliest?.time ?? null}
            dateISO={earliest?.dateISO ?? null}
            today={today}
            size="lg"
          />
          {earliest?.assumed && earliest.areaName && label(ctx, "slots_condition_template") && (
            <p className="mt-1 text-xs text-pub-subtext">
              {label(ctx, "slots_condition_template").replace("{area}", earliest.areaName)}
              {label(ctx, "slots_assumed_note") && (
                <span className="ml-1 opacity-80">{label(ctx, "slots_assumed_note")}</span>
              )}
            </p>
          )}
        </div>
      </header>

      {/* 空き枠パネル（spec 2-3 ★）: エリア/コース/オプションで都度再計算。
          初期枠はサーバ計算済み、変更時は Server Action（キャッシュしない / spec 2-7）。 */}
      <section className="mb-8 rounded border border-pub-border bg-pub-surface/50 p-4">
        <AvailabilityPanel
          slug={slug}
          dateISO={initialSlots?.dateISO ?? ""}
          today={today}
          areas={initialSlots?.areas ?? []}
          courses={courses}
          options={options}
          initialSlots={initialSlots?.slots ?? []}
          initialBusy={initialSlots?.busy ?? []}
          initialWindowStartISO={initialSlots?.windowStartISO ?? null}
          initialWindowEndISO={initialSlots?.windowEndISO ?? null}
          initialAreaId={null}
          initialAreaName={initialSlots?.areaName ?? ""}
          initialAssumed={initialSlots?.assumed ?? true}
          bookingHref={bookingHref}
          labels={availabilityLabels}
        />
      </section>

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
