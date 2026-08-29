import type { Metadata } from "next";

export const dynamic = "force-dynamic";

import { getPage } from "@/lib/cms/pages-actions";
import { listMedia } from "@/lib/cms/media-actions";
import { getAllSiteSettings } from "@/lib/cms/site-settings-actions";
import { getAllTerminology } from "@/lib/cms/terminology-actions";
import { getDevSession } from "@/lib/cms/dev-session";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import type { Block, HeroBlock, CtaBlock } from "@/domain/cms/blocks";

export const metadata: Metadata = { title: "プレビュー: ホーム" };

/** imageId → { url, alt } の解決マップ */
type MediaMap = Map<string, { url: string; alt: string }>;

function renderHeroBlock(block: HeroBlock, brandName: string, media: MediaMap) {
  const image = block.imageId ? media.get(block.imageId) : undefined;
  return (
    <div
      key={block.id}
      className="relative min-h-[60vh] bg-pub-bg flex flex-col items-center justify-center text-center px-6 py-16"
    >
      {image?.url && (
        // data-URI / 外部 URL 双方を扱うため通常の img を使う（next/image は data-URI に不向き）
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.url}
          alt={image.alt}
          className="absolute inset-0 w-full h-full object-cover opacity-40"
        />
      )}
      <div className="relative">
        <h1 className="text-3xl font-heading text-pub-primary mb-4">
          {block.heading || brandName}
        </h1>
        {block.subheading && (
          <p className="text-lg text-pub-text mb-8 max-w-lg">{block.subheading}</p>
        )}
        {block.ctaLabel && block.ctaHref && (
          <a
            href={block.ctaHref}
            className="inline-block px-8 py-3 bg-pub-primary text-pub-bg font-semibold rounded-sm hover:opacity-90"
          >
            {block.ctaLabel}
          </a>
        )}
      </div>
    </div>
  );
}

function renderCtaBlock(block: CtaBlock) {
  return (
    <div
      key={block.id}
      className="bg-pub-surface border-t border-pub-border py-12 text-center"
    >
      <a
        href={block.href}
        className="inline-block px-10 py-4 bg-pub-primary text-pub-bg font-semibold rounded-sm hover:opacity-90 text-lg"
      >
        {block.label}
      </a>
      {block.subtext && (
        <p className="mt-2 text-sm text-pub-subtext">{block.subtext}</p>
      )}
    </div>
  );
}

function renderBlock(block: Block, brandName: string, media: MediaMap): React.ReactNode {
  if (!block.visible) return null;
  switch (block.type) {
    case "hero":
      return renderHeroBlock(block, brandName, media);
    case "cta":
      return renderCtaBlock(block);
    case "text":
      return (
        <div key={block.id} className="max-w-2xl mx-auto py-10 px-6">
          <div className="text-pub-text leading-relaxed whitespace-pre-wrap">{block.body}</div>
        </div>
      );
    case "notice":
      return (
        <div key={block.id} className="max-w-2xl mx-auto py-6 px-6">
          <div className="border border-pub-border bg-pub-surface rounded p-4 text-pub-text text-sm">
            {block.body}
          </div>
        </div>
      );
    default:
      return (
        <div key={block.id} className="max-w-2xl mx-auto py-4 px-6">
          <div className="border border-pub-border bg-pub-surface rounded p-3 text-pub-subtext text-xs font-mono">
            [{block.type}] ブロック（プレビュー未実装）
          </div>
        </div>
      );
  }
}

export default async function PreviewHomePage() {
  // 機微データの露出防止（本番・未 Auth では 403 相当）。
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return (
      <div className="bg-adm-surface border border-adm-border rounded p-6">
        <p className="text-sm text-adm-text">権限がありません。</p>
      </div>
    );
  }

  const page = await getPage("home", "ja");
  const settings = await getAllSiteSettings();
  const terms = await getAllTerminology("ja");
  const mediaItems = await listMedia();
  const media: MediaMap = new Map(
    mediaItems.map((m) => [m.id, { url: m.url, alt: m.alt }]),
  );

  const brandName = String(settings["brand_name"] ?? "（屋号未設定）");
  const staffNoun = terms["staff_noun"] ?? "セラピスト";

  // 公開ブロックがあればそれを使い、なければドラフトにフォールバック
  const useDraft = !page?.publishedBlocks;
  const blocks = page?.publishedBlocks ?? page?.draftBlocks ?? [];

  return (
    <div className="space-y-4">
      {/* プレビューバナー */}
      <div className="bg-adm-surface border border-adm-caution rounded px-4 py-3 flex items-center gap-3">
        <span className="text-adm-caution text-sm font-medium">プレビューモード</span>
        {useDraft && (
          <span className="text-adm-caution text-xs">（公開データなし — ドラフトを表示中）</span>
        )}
        <span className="text-adm-text text-xs ml-auto">
          屋号: {brandName} / {staffNoun}
        </span>
      </div>

      {/* 公開側レンダラー */}
      <div className="bg-pub-bg min-h-[400px] rounded border border-adm-border overflow-hidden">
        {blocks.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-pub-subtext text-sm">
            ブロックがありません。エディタでブロックを追加してください。
          </div>
        ) : (
          blocks.map((block) => renderBlock(block, brandName, media))
        )}
      </div>
    </div>
  );
}
