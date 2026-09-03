import type { Metadata } from "next";
import Link from "next/link";
import { getCustomerPortal, type CustomerPortal } from "@/lib/customer-portal/queries";
import { getSiteContext, label } from "@/lib/public/content";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await getSiteContext();
  return { title: label(ctx, "customer_portal_title") || "My Page", robots: { index: false } };
}

// spec 12-1 公開側（暗い画面）
const C = {
  bg: "#151A20",
  surface: "#1E252D",
  text: "#EDE9E2",
  sub: "#9BA5AF",
  gold: "#C6A15B",
  line: "#2C343D",
  green: "#5E9E86",
} as const;

const STATUS_KEY: Record<string, string> = {
  done: "customer_portal_status_done",
  confirmed: "customer_portal_status_confirmed",
  enroute: "customer_portal_status_enroute",
  in_service: "customer_portal_status_in_service",
};

export default async function CustomerPortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data: CustomerPortal | null = await getCustomerPortal(token);
  const ctx = await getSiteContext();
  const t = (k: string) => label(ctx, k);

  if (!data) {
    return (
      <main style={{ minHeight: "100vh", background: C.bg, color: C.text, display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 15 }}>{t("customer_portal_invalid")}</p>
          <p style={{ fontSize: 13, color: C.sub, marginTop: 8 }}>{t("customer_portal_invalid_sub")}</p>
        </div>
      </main>
    );
  }

  // 前に指名した女性（履歴からユニーク）
  const seen = new Set<string>();
  const therapists = data.history
    .filter((h) => h.therapistSlug && !seen.has(h.therapistSlug) && seen.add(h.therapistSlug))
    .map((h) => ({ name: h.therapist, slug: h.therapistSlug as string }));

  return (
    <main style={{ minHeight: "100vh", background: C.bg, color: C.text, padding: "20px 16px", maxWidth: 560, margin: "0 auto" }}>
      <p style={{ fontSize: 13, color: C.sub }}>{t("customer_portal_title")}</p>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "2px 0 16px" }}>
        {data.name} {t("customer_portal_name_suffix")}
      </h1>

      {/* ポイント残高 */}
      <section style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: C.sub }}>{t("customer_portal_points")}</p>
        <p style={{ fontSize: 34, fontWeight: 800, color: C.gold, fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.1, margin: "2px 0" }}>
          {data.points.toLocaleString()} <span style={{ fontSize: 16 }}>pt</span>
        </p>
      </section>

      {/* 前に指名した女性 */}
      {therapists.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 13, color: C.sub, marginBottom: 8 }}>{t("customer_portal_therapists")}</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {therapists.map((th) => (
              <Link
                key={th.slug}
                href={`/therapists/${th.slug}`}
                style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 12px", color: C.text, textDecoration: "none", fontSize: 14 }}
              >
                {th.name} <span style={{ color: C.green, fontSize: 12 }}>{t("customer_portal_profile_cta")}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 予約履歴 */}
      <section>
        <h2 style={{ fontSize: 13, color: C.sub, marginBottom: 8 }}>{t("customer_portal_history")}</h2>
        {data.history.length === 0 ? (
          <p style={{ fontSize: 13, color: C.sub }}>{t("customer_portal_history_empty")}</p>
        ) : (
          <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
            {data.history.map((h, i) => (
              <div key={i} style={{ padding: "10px 14px", borderTop: i === 0 ? "none" : `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 600 }}>{h.therapist}</p>
                  <p style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                    {h.date}
                    {h.course ? ` / ${h.course}` : ""}
                  </p>
                </div>
                <span style={{ fontSize: 11, color: h.status === "done" ? C.sub : C.green, whiteSpace: "nowrap" }}>
                  {t(STATUS_KEY[h.status] ?? "") || h.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <p style={{ fontSize: 11, color: C.sub, marginTop: 20, lineHeight: 1.6 }}>{t("customer_portal_footer")}</p>
    </main>
  );
}
