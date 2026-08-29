import type { Metadata } from "next";
import { CmsPage, cmsPageMetadata } from "../_components/cms-page";

/**
 * よくある質問（spec 2-1）。pages(faq) published 駆動。無ければ空状態。
 */
export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata("faq");
}

export default function FaqPage() {
  return <CmsPage slug="faq" />;
}
