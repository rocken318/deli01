import type { Metadata } from "next";
import { getSiteContext, label } from "@/lib/public/content";
import { MemberLoginForm } from "./MemberLoginForm";

/**
 * 会員ページ ログイン（発注者決定 2026-09-06）。
 * 電話番号 + 暗証番号で本人確認し、ポイント・履歴のポータル（/c/<token>）へ通す。
 * 文言はすべて ui_labels 経由（公開側 直書き日本語なし）。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await getSiteContext();
  return { title: label(ctx, "member_title") || ctx.brandName || " " };
}

export default async function MemberPage() {
  const ctx = await getSiteContext();
  return (
    <div className="mx-auto max-w-sm px-5 py-10">
      <header className="mb-5">
        <h1 className="font-heading text-2xl text-pub-text">{label(ctx, "member_title")}</h1>
        {label(ctx, "member_lead") && (
          <p className="mt-1 text-sm text-pub-subtext">{label(ctx, "member_lead")}</p>
        )}
      </header>
      <MemberLoginForm
        labels={{
          phoneLabel: label(ctx, "member_phone_label"),
          pinLabel: label(ctx, "member_pin_label"),
          loginCta: label(ctx, "member_login_cta"),
          errorBad: label(ctx, "member_error_bad"),
          errorLocked: label(ctx, "member_error_locked"),
          errorInvalid: label(ctx, "member_error_invalid"),
          loading: label(ctx, "member_loading"),
        }}
      />
      {label(ctx, "member_note") && (
        <p className="mt-4 text-xs text-pub-subtext/80">{label(ctx, "member_note")}</p>
      )}
    </div>
  );
}
