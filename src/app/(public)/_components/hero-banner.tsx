/**
 * トップのヒーローバナー（公開側 / spec 12-1）。
 *
 * アートディレクション: スマホは縦構図、PC は横構図の別画像を出し分けるため
 * next/image ではなく <picture> を使う（同一画像のレスポンシブ最適化とは目的が違う）。
 * ヒーロー画像の下に、世界観を伝えるコンセプトコピー画像（under-hero）を重ねる。
 *
 * 文言は直書きしない（alt / SEO テキストは CMS ラベル経由 / spec 3-6・13-1）。
 * under_hero_seo は画像内の文言をそのまま転記した「ページ実内容の説明」で、
 * sr-only（視覚的に非表示・読み上げ/クローラーは読む）に置く。隠しテキストで
 * 順位を操作する用途ではなく、画像で提供している情報のテキスト等価物を与える。
 * LCP 要素になるため主画像は eager 読み込み＋高優先度で先読みする（spec 12）。
 */
export function HeroBanner({
  brandName,
  underHeroAlt,
  underHeroSeo,
}: {
  brandName: string;
  underHeroAlt: string;
  underHeroSeo: string;
}) {
  return (
    <section className="w-full overflow-hidden bg-pub-bg">
      <picture>
        <source media="(min-width: 768px)" srcSet="/hero/hero-pc.jpg" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/hero/hero-mobile.jpg"
          alt={brandName}
          className="mx-auto block h-auto w-full object-cover"
          fetchPriority="high"
          decoding="async"
        />
      </picture>

      {/* ヒーロー直下のコンセプトコピー画像（縦構図・全幅／PC は中央寄せ） */}
      <div className="mx-auto w-full max-w-[640px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/hero/under-hero.png"
          alt={underHeroAlt}
          className="block h-auto w-full"
          decoding="async"
          loading="lazy"
        />
      </div>

      {/* SEO / アクセシビリティ: 画像内テキストの等価物（視覚非表示・読み上げ対象） */}
      {underHeroSeo && <p className="sr-only">{underHeroSeo}</p>}
    </section>
  );
}
