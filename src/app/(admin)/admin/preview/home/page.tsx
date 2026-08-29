import type { Metadata } from "next";
import { getPage } from "@/lib/cms/pages-actions";
import { getAllSiteSettings } from "@/lib/cms/site-settings-actions";
import { getAllTerminology } from "@/lib/cms/terminology-actions";
import type { Block, HeroBlock, CtaBlock } from "@/domain/cms/blocks";

export const metadata: Metadata = { title: "プレビュー: ホーム" };

function renderHeroBlock(block: HeroBlock, brandName: string) {
  return (
    <div
      key={block.id}
      className="relative min-h-[60vh] bg-pub-bg flex flex-col items-center justify-center text-center px-6 py-16"
    >
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

function renderBlock(block: Block, brandName: string): React.ReactNode {
  if (!block.visible) return null;
  switch (block.type) {
    case "hero":
      return renderHeroBlock(block, brandName);
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
  const page = await getPage("home", "ja");
  const settings = await getAllSiteSettings();
  const terms = await getAllTerminology("ja");

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
          blocks.map((block) => renderBlock(block, brandName))
        )}
      </div>
    </div>
  );
}
