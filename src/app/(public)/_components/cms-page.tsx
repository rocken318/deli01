import { getSiteContext, getPublishedPage, label } from "@/lib/public/content";
import { getPublicMediaMap } from "@/lib/public/queries";
import { renderBlock, collectBlockImageIds } from "./block-renderer";
import { EmptyState } from "./empty-state";

/**
 * pages(published) 駆動の汎用 CMS ページ（spec 2-1: /courses /areas /guide /faq）。
 * 公開データが無ければ空状態を出す。文言は content レイヤ（CMS）経由。
 */
export async function CmsPage({ slug }: { slug: string }) {
  const [ctx, page] = await Promise.all([getSiteContext(), getPublishedPage(slug)]);

  const hasContent = page.isPublished && (page.blocks.length > 0 || page.heading.length > 0);

  if (!hasContent) {
    return (
      <EmptyState
        title={label(ctx, "empty_page_title")}
        body={label(ctx, "empty_page_body")}
        actionLabel={label(ctx, "back_home")}
        actionHref="/"
      />
    );
  }

  const mediaMap = await getPublicMediaMap(collectBlockImageIds(page.blocks), {
    requireConsent: false,
  });

  return (
    <div>
      {(page.heading || page.lead) && (
        <header className="mx-auto max-w-2xl px-6 pt-10 pb-2 text-center">
          {page.heading && <h1 className="font-heading text-2xl text-pub-text">{page.heading}</h1>}
          {page.lead && <p className="mt-2 text-sm text-pub-subtext">{page.lead}</p>}
        </header>
      )}
      {page.blocks.map((block, i) =>
        renderBlock(block, { media: mediaMap, brandName: ctx.brandName, index: i }),
      )}
    </div>
  );
}

/** ページの SEO メタを published fields から解決する */
export async function cmsPageMetadata(slug: string) {
  const [ctx, page] = await Promise.all([getSiteContext(), getPublishedPage(slug)]);
  return {
    title: page.seoTitle || page.heading || ctx.brandName || " ",
    description: page.seoDescription || undefined,
  };
}
