import type { Metadata } from "next";
import { getSiteContext, getPublishedPage, getPublicTherapistFields, label } from "@/lib/public/content";
import { listPublicTherapists } from "@/lib/public/queries";
import { buildTherapistCards } from "@/lib/public/therapist-view";
import { getPublicMediaMap } from "@/lib/public/queries";
import Link from "next/link";
import { renderBlock, collectBlockImageIds } from "./_components/block-renderer";
import { EmptyState } from "./_components/empty-state";
import { TherapistCard } from "./_components/therapist-card";
import { EarliestSlot } from "./_components/earliest-slot";

/**
 * 公開トップ（spec 2-1）。
 * - pages(home) の published ブロックを描画（未公開なら空状態）
 * - いま出勤中のセラピスト（published therapists）をカードで
 * - 最短案内時間はフェーズ9（空き枠エンジン）未実装のため placeholder（CMS labels 経由）
 *
 * キャッシュ（spec 2-7）: プロフィール・本文は ISR、空き枠はキャッシュしない。
 * 本フェーズは空き枠値なしのため、都度描画（dynamic）にとどめ古い枠を出さない。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [ctx, page] = await Promise.all([getSiteContext(), getPublishedPage("home")]);
  return {
    title: page.seoTitle || ctx.brandName || " ",
    description: page.seoDescription || ctx.footerNote || undefined,
  };
}

export default async function HomePage() {
  const [ctx, page, therapists, fields] = await Promise.all([
    getSiteContext(),
    getPublishedPage("home"),
    listPublicTherapists(),
    getPublicTherapistFields(),
  ]);

  const cards = await buildTherapistCards(therapists, fields);
  const mediaMap = await getPublicMediaMap(collectBlockImageIds(page.blocks), {
    requireConsent: false,
  });

  const earliestTemplate = label(ctx, "earliest_slot_template");
  const earliestPending = label(ctx, "earliest_slot_pending");
  const bookingHref = ctx.labels["booking_href"] || "/booking";

  return (
    <div>
      {/* pages(home) published ブロック（未公開なら空状態） */}
      {page.isPublished && page.blocks.length > 0 ? (
        page.blocks.map((block, i) =>
          renderBlock(block, { media: mediaMap, brandName: ctx.brandName, index: i }),
        )
      ) : (
        <EmptyState
          title={label(ctx, "empty_home_title")}
          body={label(ctx, "empty_home_body")}
        />
      )}

      {/* いま案内できるセラピスト（署名要素の枠を各カードに用意） */}
      <section className="mx-auto max-w-3xl px-5 py-10">
        {(label(ctx, "therapists_section_title") || earliestTemplate) && (
          <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
            <h2 className="font-heading text-xl text-pub-text">
              {label(ctx, "therapists_section_title")}
            </h2>
            <EarliestSlot
              template={earliestTemplate}
              placeholder={earliestPending}
              time={null}
              size="sm"
            />
          </div>
        )}

        {cards.length === 0 ? (
          <EmptyState
            title={label(ctx, "empty_therapists_title")}
            body={label(ctx, "empty_therapists_body")}
          />
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {cards.map((card) => (
              <li key={card.slug}>
                <TherapistCard
                  card={card}
                  detailLabel={label(ctx, "therapist_detail_cta")}
                  earliestTemplate={earliestTemplate}
                  earliestPending={earliestPending}
                />
              </li>
            ))}
          </ul>
        )}

        {label(ctx, "view_all_therapists") && (
          <div className="mt-6 text-center">
            <Link
              href="/therapists"
              className="inline-block rounded border border-pub-border px-6 py-2.5 text-sm text-pub-text hover:border-pub-primary hover:text-pub-primary"
            >
              {label(ctx, "view_all_therapists")}
            </Link>
          </div>
        )}
      </section>

      {/* 予約導線（署名要素の全幅版） */}
      {earliestTemplate && (
        <section className="mx-auto max-w-3xl px-5 pb-12 text-center">
          <Link href={bookingHref} className="inline-block">
            <EarliestSlot template={earliestTemplate} placeholder={earliestPending} time={null} size="lg" />
          </Link>
        </section>
      )}
    </div>
  );
}
