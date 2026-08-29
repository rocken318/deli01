import Image from "next/image";

/**
 * 公開画像（spec 12-1: next/image・LCP 配慮）。
 *
 * seed のプレースホルダは data:URI SVG。next/image は data:URI も unoptimized で
 * 表示できる。実写真（外部/Storage URL）に差し替わっても same API で扱えるよう、
 * data:URI のときだけ unoptimized にする。
 */
export function PublicImage({
  src,
  alt,
  width,
  height,
  className,
  priority,
  sizes,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
  sizes?: string;
}) {
  const isData = src.startsWith("data:");
  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      priority={priority}
      sizes={sizes}
      unoptimized={isData}
    />
  );
}
