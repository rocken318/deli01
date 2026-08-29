import type { Metadata } from "next";
import { getSiteContext, label } from "@/lib/public/content";
import { EmptyState } from "../_components/empty-state";

/**
 * 予約フロー（spec 2-1 / 6章）。注文画面・仮押さえはフェーズ11。
 * 本フェーズは導線として存在する空状態スタブ。電話受付は receptionPhone を提示。
 * 文言は CMS labels 経由。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await getSiteContext();
  return { title: label(ctx, "booking_page_title") || ctx.brandName || " " };
}

export default async function BookingPage() {
  const ctx = await getSiteContext();
  return (
    <div className="py-8">
      <EmptyState
        title={label(ctx, "booking_pending_title")}
        body={label(ctx, "booking_pending_body")}
      />
      {ctx.receptionPhone && (
        <div className="mx-auto max-w-md px-6 pb-8 text-center">
          <a
            href={`tel:${ctx.receptionPhone}`}
            className="inline-block rounded bg-pub-primary px-8 py-3 font-mono text-pub-bg hover:opacity-90"
          >
            {ctx.receptionPhone}
          </a>
          {ctx.receptionHours && (
            <p className="mt-2 text-xs text-pub-subtext">{ctx.receptionHours}</p>
          )}
        </div>
      )}
    </div>
  );
}
