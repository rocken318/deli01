import type { Metadata } from "next";
import { getSiteContext, label } from "@/lib/public/content";
import { EmptyState } from "../_components/empty-state";

/**
 * 出勤表（spec 2-1 / 2-3）。日別の派遣可能一覧はフェーズ8、空き枠はフェーズ9-10。
 * 本フェーズはリンク先として存在する空状態スタブ。文言は CMS labels 経由。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await getSiteContext();
  return { title: label(ctx, "schedule_page_title") || ctx.brandName || " " };
}

export default async function SchedulePage() {
  const ctx = await getSiteContext();
  return (
    <div className="py-8">
      <EmptyState
        title={label(ctx, "schedule_pending_title")}
        body={label(ctx, "schedule_pending_body")}
        actionLabel={label(ctx, "view_all_therapists")}
        actionHref="/therapists"
      />
    </div>
  );
}
