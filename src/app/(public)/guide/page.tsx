import type { Metadata } from "next";
import { CmsPage, cmsPageMetadata } from "../_components/cms-page";

/**
 * 利用の流れ（spec 2-1）。pages(guide) published 駆動。無ければ空状態。
 */
export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata("guide");
}

export default function GuidePage() {
  return <CmsPage slug="guide" />;
}
