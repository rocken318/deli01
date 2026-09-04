import type { Metadata } from "next";
import Link from "next/link";
import { getSiteContext, getPublicTherapistFields, label } from "@/lib/public/content";
import { listPublicTherapists, getSlugsWorkingToday } from "@/lib/public/queries";
import { buildTherapistCards, collectFilterTagChoices } from "@/lib/public/therapist-view";
import { listScheduleAreas } from "@/lib/schedule/queries";
import { earliestSlotForTherapist } from "@/lib/availability/earliest";
import { TherapistFilter } from "./therapist-filter";

/**
 * セラピスト一覧（spec 2-1 / 2-4）★。published なセラピストのカード + 絞り込み。
 * 未公開・未同意・退職は listPublicTherapists の段階で除外される。
 *
 * 絞り込み（spec 2-4）:
 * - エリア: 空き枠算出（earliest / spec 5-4）で「そのエリアに案内できる人」だけに絞る。
 *   エリアを選ぶと URL ?area= が付き、サーバで最短案内時刻を再計算して一覧が変わる
 *   （★フェーズ10 完了条件: エリア指定で一覧が変わる）。
 * - 得意な施術タグ: クライアント側（field_definitions 由来の choices）。
 *
 * キャッシュ（spec 2-7）: 空き枠を都度計算するため force-dynamic（古い枠を出さない）。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await getSiteContext();
  return { title: label(ctx, "therapists_page_title") || ctx.brandName || " " };
}

function therapistsHref(areaId: string | null): string {
  return areaId ? `/therapists?area=${encodeURIComponent(areaId)}` : "/therapists";
}

export default async function TherapistsPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
}) {
  const sp = await searchParams;
  const [ctx, fields, therapists, areas, workingTodaySet] = await Promise.all([
    getSiteContext(),
    getPublicTherapistFields(),
    listPublicTherapists(),
    listScheduleAreas(),
    getSlugsWorkingToday(),
  ]);

  const areaId = areas.some((a) => a.id === sp.area) ? (sp.area ?? null) : null;

  // エリア指定時: 各セラピストの最短案内時刻をそのエリアで再計算し、
  // 案内できる人（earliest 非 null）だけに絞る（spec 2-4「エリアで絞り込む」）。
  let filteredTherapists = therapists;
  const earliestBySlug = new Map<string, Awaited<ReturnType<typeof earliestSlotForTherapist>>>();
  if (areaId) {
    const results = await Promise.all(
      therapists.map(
        async (t) =>
          [t.slug, await earliestSlotForTherapist(t.slug, { areaId }).catch(() => null)] as const,
      ),
    );
    for (const [slug, info] of results) earliestBySlug.set(slug, info);
    filteredTherapists = therapists.filter((t) => earliestBySlug.get(t.slug) != null);
  }

  const cards = await buildTherapistCards(filteredTherapists, fields);
  const tagChoices = collectFilterTagChoices(fields);

  const conditionTemplate = label(ctx, "slots_condition_template");
  const cardsWithEarliest = cards.map((c) => {
    const info = earliestBySlug.get(c.slug) ?? null;
    return {
      card: c,
      earliestTime: info?.time ?? null,
      conditionNote:
        info && !info.assumed && info.areaName && conditionTemplate
          ? conditionTemplate.replace("{area}", info.areaName)
          : "",
      workingToday: workingTodaySet.has(c.slug),
    };
  });

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-heading text-2xl text-pub-text">
          {label(ctx, "therapists_page_title")}
        </h1>
        {label(ctx, "therapists_page_lead") && (
          <p className="mt-1 text-sm text-pub-subtext">{label(ctx, "therapists_page_lead")}</p>
        )}
      </header>

      {/* エリア絞り込み（サーバ再計算。名前は DB / spec 2-4） */}
      {areas.length > 0 && (
        <section aria-label={label(ctx, "slots_area_heading") || undefined} className="mb-6">
          {label(ctx, "slots_area_heading") && (
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
              {label(ctx, "slots_area_heading")}
            </h2>
          )}
          <ul className="flex flex-wrap gap-2">
            <li>
              <Link
                href={therapistsHref(null)}
                aria-current={areaId === null ? "true" : undefined}
                className={`inline-block rounded-full border px-3 py-1 text-sm transition-colors ${
                  areaId === null
                    ? "border-pub-primary bg-pub-primary/10 text-pub-primary"
                    : "border-pub-border text-pub-subtext hover:border-pub-primary hover:text-pub-text"
                }`}
              >
                {label(ctx, "filter_all")}
              </Link>
            </li>
            {areas.map((a) => (
              <li key={a.id}>
                <Link
                  href={therapistsHref(a.id)}
                  aria-current={areaId === a.id ? "true" : undefined}
                  className={`inline-block rounded-full border px-3 py-1 text-sm transition-colors ${
                    areaId === a.id
                      ? "border-pub-primary bg-pub-primary/10 text-pub-primary"
                      : "border-pub-border text-pub-subtext hover:border-pub-primary hover:text-pub-text"
                  }`}
                >
                  {a.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <TherapistFilter
        cards={cardsWithEarliest}
        tagChoices={tagChoices}
        labels={{
          filterHeading: label(ctx, "filter_good_at_heading"),
          filterAllTags: label(ctx, "filter_all"),
          detailCta: label(ctx, "therapist_detail_cta"),
          earliestTemplate: label(ctx, "earliest_slot_template"),
          earliestPending: label(ctx, "earliest_slot_pending"),
          emptyTitle: label(ctx, "empty_therapists_title"),
          emptyBody: label(ctx, "empty_therapists_body"),
          todayBadge: label(ctx, "therapist_today_badge"),
        }}
      />
    </div>
  );
}
