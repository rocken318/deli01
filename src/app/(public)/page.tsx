import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { getSiteContext, getPublishedPage, getPublicTherapistFields, label } from "@/lib/public/content";
import { listPublicTherapists } from "@/lib/public/queries";
import { buildTherapistCards } from "@/lib/public/therapist-view";
import { getPublicMediaMap } from "@/lib/public/queries";
import { earliestSlotForTherapist } from "@/lib/availability/earliest";
import { localDateISO } from "@/domain/availability";
import Link from "next/link";
import { renderBlock, collectBlockImageIds } from "./_components/block-renderer";
import { EmptyState } from "./_components/empty-state";
import { TherapistCard } from "./_components/therapist-card";
import { EarliestSlot } from "./_components/earliest-slot";
import { HeroBanner } from "./_components/hero-banner";

/**
 * 公開トップ（spec 2-1）。
 * - pages(home) の published ブロックを描画（未公開なら空状態）
 * - いま出勤中のセラピスト（published therapists）をカードで
 * - 最短案内時間は空き枠エンジン（spec 5-4）で代表エリア概算し、前提を明記する
 *
 * キャッシュ（spec 2-7）: ページ自体は force-dynamic（ビルド時に DB を要求しない＝
 * feedback-no-over-configuration）。ただし本番でリクエスト毎の DB 読取（特に全セラピストの
 * 空き枠計算）がサーバレスの stale 接続で詰まり、ページごとハング→画像が出ない事故が発生した。
 * そこで DB 読取一式を unstable_cache（revalidate=30）で実行時キャッシュし、大半のリクエストを
 * DB 非依存で高速配信する（spec の「60秒以内に反映」許容内・空き枠は最大30秒の概算ずれを許容）。
 */
export const dynamic = "force-dynamic";

/** 4秒でタイムアウト（空き枠計算が詰まってもデータ生成を止めない） */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** サイト共通文言＋home ページ（メタデータ用・30秒キャッシュ） */
const loadSiteAndPage = unstable_cache(
  async () => {
    const [ctx, page] = await Promise.all([
      getSiteContext(),
      getPublishedPage("home"),
    ]);
    return { ctx, page };
  },
  ["home-site-and-page-v1"],
  { revalidate: 30 },
);

/** トップの読取一式（文言・セラピスト・メディア・空き枠）を1回にまとめて30秒キャッシュ */
const loadHomeData = unstable_cache(
  async () => {
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
    // 空き枠計算はタイムアウト付き（遅い/ハング時は null＝「調整中」）
    const earliestEntries = await Promise.all(
      cards.map(
        async (c) =>
          [
            c.slug,
            await withTimeout(
              earliestSlotForTherapist(c.slug).catch(() => null),
              4000,
              null,
            ),
          ] as const,
      ),
    );
    return {
      ctx,
      page,
      cards,
      mediaMapEntries: [...mediaMap.entries()],
      earliestEntries,
    };
  },
  ["home-data-v1"],
  { revalidate: 30 },
);

export async function generateMetadata(): Promise<Metadata> {
  const { ctx, page } = await loadSiteAndPage();
  return {
    title: page.seoTitle || ctx.brandName || " ",
    description: page.seoDescription || ctx.footerNote || undefined,
  };
}

export default async function HomePage() {
  const { ctx, page, cards, mediaMapEntries, earliestEntries } =
    await loadHomeData();
  const mediaMap = new Map(mediaMapEntries);
  const earliestBySlug = new Map(earliestEntries);
  // 署名要素（セクション見出し）は、いま案内できる中で最も早い枠を代表として出す
  const sectionEarliest = [...earliestBySlug.values()]
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => `${a.dateISO} ${a.time}`.localeCompare(`${b.dateISO} ${b.time}`))[0];

  const conditionTemplate = label(ctx, "slots_condition_template");
  const assumedNote = label(ctx, "slots_assumed_note");
  const conditionNote = (e: { assumed: boolean; areaName: string } | null): string =>
    e && e.assumed && e.areaName && conditionTemplate
      ? `${conditionTemplate.replace("{area}", e.areaName)}${assumedNote}`
      : "";

  const today = localDateISO(new Date());
  const earliestTemplate = label(ctx, "earliest_slot_template");
  const earliestTemplateFuture = label(ctx, "earliest_slot_template_future");
  const earliestPending = label(ctx, "earliest_slot_pending");
  const weekdays = label(ctx, "schedule_weekdays");
  const bookingHref = ctx.labels["booking_href"] || "/booking";

  return (
    <div>
      {/* ヒーローバナー（スマホ/PC で別画像・アートディレクション＋コンセプトコピー画像） */}
      <HeroBanner
        brandName={ctx.brandName}
        underHeroAlt={label(ctx, "under_hero_alt")}
        underHeroSeo={label(ctx, "under_hero_seo")}
      />

      {/* pages(home) published ブロック（未公開なら空状態） */}
      {page.isPublished && page.blocks.length > 0 ? (
        page.blocks.map((block, i) =>
          renderBlock(block, {
            media: mediaMap,
            brandName: ctx.brandName,
            index: i,
            playItemLabel: label(ctx, "play_item_label"),
          }),
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
            <div>
              {/* 重大1: 当日以外の枠は日付を明記。推奨2: 目玉にも条件注記を付ける */}
              <EarliestSlot
                template={earliestTemplate}
                templateFuture={earliestTemplateFuture}
                placeholder={earliestPending}
                weekdays={weekdays}
                time={sectionEarliest?.time ?? null}
                dateISO={sectionEarliest?.dateISO ?? null}
                today={today}
                size="sm"
              />
              {sectionEarliest?.assumed && sectionEarliest.areaName && conditionTemplate && (
                <p className="text-xs text-pub-subtext/80">
                  {conditionTemplate.replace("{area}", sectionEarliest.areaName)}
                  {assumedNote && <span className="ml-1 opacity-80">{assumedNote}</span>}
                </p>
              )}
            </div>
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
                  earliestTemplateFuture={earliestTemplateFuture}
                  earliestPending={earliestPending}
                  weekdays={weekdays}
                  earliestTime={earliestBySlug.get(card.slug)?.time ?? null}
                  earliestDateISO={earliestBySlug.get(card.slug)?.dateISO ?? null}
                  today={today}
                  conditionNote={conditionNote(earliestBySlug.get(card.slug) ?? null)}
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

      {/* 予約導線（署名要素の全幅版）: 重大1 + 推奨2（目玉に条件注記） */}
      {earliestTemplate && (
        <section className="mx-auto max-w-3xl px-5 pb-12 text-center">
          <Link href={bookingHref} className="inline-block">
            <EarliestSlot
              template={earliestTemplate}
              templateFuture={earliestTemplateFuture}
              placeholder={earliestPending}
              weekdays={weekdays}
              time={sectionEarliest?.time ?? null}
              dateISO={sectionEarliest?.dateISO ?? null}
              today={today}
              size="lg"
            />
          </Link>
          {sectionEarliest?.assumed && sectionEarliest.areaName && conditionTemplate && (
            <p className="mt-1 text-xs text-pub-subtext/80">
              {conditionTemplate.replace("{area}", sectionEarliest.areaName)}
              {assumedNote && <span className="ml-1 opacity-80">{assumedNote}</span>}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
