import type { Metadata } from "next";
import Link from "next/link";
import { getCustomerPortal } from "@/lib/customer-portal/queries";

export const metadata: Metadata = { title: "マイページ", robots: { index: false } };
export const dynamic = "force-dynamic";

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

const STATUS_LABEL: Record<string, string> = {
  done: "利用済み",
  confirmed: "予約確定",
  enroute: "移動中",
  in_service: "接客中",
};

export default async function CustomerPortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await getCustomerPortal(token);

  if (!data) {
    return (
      <main style={{ minHeight: "100vh", background: C.bg, color: C.text, display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 15 }}>このリンクは無効か、有効期限が切れています。</p>
          <p style={{ fontSize: 13, color: C.sub, marginTop: 8 }}>お手数ですが、最新のご案内リンクをご確認ください。</p>
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
      <p style={{ fontSize: 13, color: C.sub }}>マイページ</p>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "2px 0 16px" }}>{data.name} 様</h1>

      {/* ポイント残高 */}
      <section style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: C.sub }}>ポイント残高</p>
        <p style={{ fontSize: 34, fontWeight: 800, color: C.gold, fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.1, margin: "2px 0" }}>
          {data.points.toLocaleString()} <span style={{ fontSize: 16 }}>pt</span>
        </p>
      </section>

      {/* 前に指名した女性 */}
      {therapists.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 13, color: C.sub, marginBottom: 8 }}>前にご利用の女性</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {therapists.map((t) => (
              <Link
                key={t.slug}
                href={`/therapists/${t.slug}`}
                style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 12px", color: C.text, textDecoration: "none", fontSize: 14 }}
              >
                {t.name} <span style={{ color: C.green, fontSize: 12 }}>プロフィール ›</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 予約履歴 */}
      <section>
        <h2 style={{ fontSize: 13, color: C.sub, marginBottom: 8 }}>ご利用・ご予約履歴</h2>
        {data.history.length === 0 ? (
          <p style={{ fontSize: 13, color: C.sub }}>まだご利用履歴はありません。</p>
        ) : (
          <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
            {data.history.map((h, i) => (
              <div key={i} style={{ padding: "10px 14px", borderTop: i === 0 ? "none" : `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 600 }}>{h.therapist}</p>
                  <p style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                    {h.date}
                    {h.course ? ` ・ ${h.course}` : ""}
                  </p>
                </div>
                <span style={{ fontSize: 11, color: h.status === "done" ? C.sub : C.green, whiteSpace: "nowrap" }}>
                  {STATUS_LABEL[h.status] ?? h.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <p style={{ fontSize: 11, color: C.sub, marginTop: 20, lineHeight: 1.6 }}>
        このページはお客様専用リンクです。第三者に共有しないでください。
      </p>
    </main>
  );
}
