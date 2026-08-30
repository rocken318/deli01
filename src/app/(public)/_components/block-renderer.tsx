import Link from "next/link";
import type {
  Block,
  HeroBlock,
  TextBlock,
  ImageBlock,
  TextImageBlock,
  StepsBlock,
  FaqBlock,
  NoticeBlock,
  CtaBlock,
  PlayBlock,
} from "@/domain/cms/blocks";
import type { PublicMedia } from "@/lib/public/queries";
import { PublicImage } from "./public-image";

/**
 * 公開ブロックレンダラー（spec 3-6）。管理側 preview の描画を公開用に昇格。
 * 全テキストはブロック（CMS published）由来。日本語リテラルを持たない。
 * media は公開可能なもの（consent 済み・非表示でない）のマップから解決する。
 */

export type BlockMediaMap = Map<string, PublicMedia>;

function Hero({ block, media, brandName, priority }: { block: HeroBlock; media: BlockMediaMap; brandName: string; priority: boolean }) {
  const image = block.imageId ? media.get(block.imageId) : undefined;
  const heading = block.heading || brandName;
  return (
    <section className="relative flex min-h-[60vh] flex-col items-center justify-center overflow-hidden px-6 py-16 text-center">
      {image && (
        <PublicImage
          src={image.url}
          alt={image.alt}
          width={image.width ?? 1200}
          height={image.height ?? 675}
          className="absolute inset-0 h-full w-full object-cover opacity-40"
          priority={priority}
          sizes="100vw"
        />
      )}
      <div className="relative max-w-lg">
        {heading && <h1 className="mb-4 font-heading text-3xl leading-snug text-pub-text">{heading}</h1>}
        {block.subheading && <p className="mb-6 text-pub-subtext">{block.subheading}</p>}
        {block.ctaLabel && block.ctaHref && (
          <Link
            href={block.ctaHref}
            className="inline-block rounded bg-pub-primary px-8 py-3 font-medium text-pub-bg hover:opacity-90"
          >
            {block.ctaLabel}
          </Link>
        )}
      </div>
    </section>
  );
}

function TextBody({ block }: { block: TextBlock }) {
  if (!block.body) return null;
  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="whitespace-pre-wrap leading-relaxed text-pub-text">{block.body}</div>
    </div>
  );
}

function ImageBlockView({ block, media }: { block: ImageBlock; media: BlockMediaMap }) {
  const image = block.imageId ? media.get(block.imageId) : undefined;
  if (!image) return null;
  return (
    <figure className="mx-auto max-w-2xl px-6 py-6">
      <PublicImage
        src={image.url}
        alt={block.alt || image.alt}
        width={image.width ?? 1200}
        height={image.height ?? 675}
        className="w-full rounded border border-pub-border object-cover"
        sizes="(max-width: 768px) 100vw, 672px"
      />
      {block.caption && <figcaption className="mt-2 text-sm text-pub-subtext">{block.caption}</figcaption>}
    </figure>
  );
}

function TextImageView({ block, media }: { block: TextImageBlock; media: BlockMediaMap }) {
  const image = block.imageId ? media.get(block.imageId) : undefined;
  return (
    <div className="mx-auto grid max-w-2xl gap-5 px-6 py-8 sm:grid-cols-2 sm:items-center">
      {image && (
        <div className={block.imagePosition === "left" ? "sm:order-1" : "sm:order-2"}>
          <PublicImage
            src={image.url}
            alt={block.alt || image.alt}
            width={image.width ?? 1200}
            height={image.height ?? 675}
            className="w-full rounded border border-pub-border object-cover"
            sizes="(max-width: 640px) 100vw, 320px"
          />
        </div>
      )}
      {block.body && (
        <div className={`whitespace-pre-wrap leading-relaxed text-pub-text ${block.imagePosition === "left" ? "sm:order-2" : "sm:order-1"}`}>
          {block.body}
        </div>
      )}
    </div>
  );
}

function Steps({ block }: { block: StepsBlock }) {
  if (block.items.length === 0 && !block.heading) return null;
  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      {block.heading && <h2 className="mb-4 font-heading text-xl text-pub-text">{block.heading}</h2>}
      <ol className="space-y-4">
        {block.items.map((item, i) => (
          <li key={i} className="rounded border border-pub-border bg-pub-surface p-4">
            <p className="font-mono text-sm text-pub-primary">{String(i + 1).padStart(2, "0")}</p>
            {item.label && <p className="mt-1 font-medium text-pub-text">{item.label}</p>}
            {item.body && <p className="mt-1 text-sm text-pub-subtext">{item.body}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Faq({ block }: { block: FaqBlock }) {
  if (block.items.length === 0 && !block.heading) return null;
  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      {block.heading && <h2 className="mb-4 font-heading text-xl text-pub-text">{block.heading}</h2>}
      <dl className="space-y-3">
        {block.items.map((item, i) => (
          <div key={i} className="rounded border border-pub-border bg-pub-surface p-4">
            <dt className="font-medium text-pub-text">{item.q}</dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm text-pub-subtext">{item.a}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Notice({ block }: { block: NoticeBlock }) {
  if (!block.body) return null;
  return (
    <div className="mx-auto max-w-2xl px-6 py-4">
      <div className="rounded border border-pub-border bg-pub-surface p-4 text-sm text-pub-text">
        {block.body}
      </div>
    </div>
  );
}

function Play({ block, itemLabel }: { block: PlayBlock; itemLabel: string }) {
  const items = block.items.filter((it) => it.body.trim().length > 0);
  if (items.length === 0 && !block.heading) return null;
  return (
    <section className="mx-auto max-w-2xl px-6 py-8">
      {block.heading && (
        <h2 className="mb-4 font-heading text-xl text-pub-text">{block.heading}</h2>
      )}
      <div className="space-y-4">
        {items.map((item, i) => (
          <div key={i} className="rounded border border-pub-border bg-pub-surface p-4">
            <p className="font-heading text-base text-pub-primary">
              {itemLabel}
              {i + 1}
            </p>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed text-pub-text">
              {item.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Cta({ block }: { block: CtaBlock }) {
  if (!block.label || !block.href) return null;
  return (
    <div className="border-t border-pub-border bg-pub-surface py-10 text-center">
      <Link
        href={block.href}
        className="inline-block rounded bg-pub-primary px-10 py-4 text-lg font-medium text-pub-bg hover:opacity-90"
      >
        {block.label}
      </Link>
      {block.subtext && <p className="mt-2 text-sm text-pub-subtext">{block.subtext}</p>}
    </div>
  );
}

/** 1ブロックを描画（未対応 type は何も出さない） */
export function renderBlock(
  block: Block,
  opts: { media: BlockMediaMap; brandName: string; index: number; playItemLabel?: string },
): React.ReactNode {
  if (!block.visible) return null;
  const priority = opts.index === 0;
  switch (block.type) {
    case "hero":
      return <Hero key={block.id} block={block} media={opts.media} brandName={opts.brandName} priority={priority} />;
    case "text":
      return <TextBody key={block.id} block={block} />;
    case "image":
      return <ImageBlockView key={block.id} block={block} media={opts.media} />;
    case "text_image":
      return <TextImageView key={block.id} block={block} media={opts.media} />;
    case "steps":
      return <Steps key={block.id} block={block} />;
    case "faq":
      return <Faq key={block.id} block={block} />;
    case "notice":
      return <Notice key={block.id} block={block} />;
    case "cta":
      return <Cta key={block.id} block={block} />;
    case "play":
      return <Play key={block.id} block={block} itemLabel={opts.playItemLabel ?? ""} />;
    // therapist_picks / course_list はデータがフェーズ6-7で揃うため本フェーズは非描画
    default:
      return null;
  }
}

/** imageId を持ちうるブロックから media id を集める（media 一括解決用） */
export function collectBlockImageIds(blocks: Block[]): string[] {
  const ids: string[] = [];
  for (const b of blocks) {
    if ("imageId" in b && typeof b.imageId === "string" && b.imageId.length > 0) {
      ids.push(b.imageId);
    }
  }
  return ids;
}
