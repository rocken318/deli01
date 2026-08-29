import type { Metadata } from "next";
import { getSiteContext, getPublicTherapistFields, label } from "@/lib/public/content";
import { listPublicTherapists } from "@/lib/public/queries";
import { buildTherapistCards, collectFilterTagChoices } from "@/lib/public/therapist-view";
import { TherapistFilter } from "./therapist-filter";

/**
 * セラピスト一覧（spec 2-1 / 2-4）★。published なセラピストのカード + 絞り込み。
 * 未公開・未同意・退職は listPublicTherapists の段階で除外される。
 *
 * キャッシュ（spec 2-7）: プロフィール本文・写真は ISR。60秒 revalidate。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await getSiteContext();
  return { title: label(ctx, "therapists_page_title") || ctx.brandName || " " };
}

export default async function TherapistsPage() {
  const [ctx, fields, therapists] = await Promise.all([
    getSiteContext(),
    getPublicTherapistFields(),
    listPublicTherapists(),
  ]);

  const cards = await buildTherapistCards(therapists, fields);
  const tagChoices = collectFilterTagChoices(fields);

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

      <TherapistFilter
        cards={cards}
        tagChoices={tagChoices}
        labels={{
          filterHeading: label(ctx, "filter_good_at_heading"),
          filterAllTags: label(ctx, "filter_all"),
          detailCta: label(ctx, "therapist_detail_cta"),
          earliestTemplate: label(ctx, "earliest_slot_template"),
          earliestPending: label(ctx, "earliest_slot_pending"),
          emptyTitle: label(ctx, "empty_therapists_title"),
          emptyBody: label(ctx, "empty_therapists_body"),
        }}
      />
    </div>
  );
}
