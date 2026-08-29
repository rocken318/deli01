import type { Metadata } from "next";
import { CmsPage, cmsPageMetadata } from "../_components/cms-page";

/**
 * 対応エリアと交通費（spec 2-1）。pages(areas) published 駆動。
 * エリアの実データはフェーズ6 なので、当面は pages ブロック or 空状態。
 */
export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata("areas");
}

export default function AreasPage() {
  return <CmsPage slug="areas" />;
}
