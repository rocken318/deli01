import type { Metadata } from "next";
import { CmsPage, cmsPageMetadata } from "../_components/cms-page";

/**
 * コース・オプションと料金（spec 2-1）。pages(courses) published 駆動。
 * コースの実データはフェーズ7 なので、当面は pages ブロック or 空状態。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata("courses");
}

export default function CoursesPage() {
  return <CmsPage slug="courses" />;
}
