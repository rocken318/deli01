/**
 * /admin/history — 接客履歴（完了予約）。owner/admin は全セラピスト分を閲覧できる。
 * ?therapist=<slug> で1人に絞り込み、?page=N でページング。
 */

import Link from "next/link";
import { getServiceHistoryAdmin } from "@/lib/admin/service-history";

export const metadata = { title: "接客履歴" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const YEN = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

interface PageProps {
  searchParams: Promise<{ therapist?: string; page?: string }>;
}

export default async function HistoryPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const therapist = typeof sp.therapist === "string" ? sp.therapist : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const outcome = await getServiceHistoryAdmin({
    therapistSlug: therapist,
    limit: PAGE_SIZE,
    offset,
  });

  if (outcome.kind === "forbidden") {
    return (
      <div
        role="alert"
        className="border p-4 text-sm"
        style={{ borderColor: "#B4453C", color: "#B4453C", borderRadius: "4px" }}
      >
        この画面を表示する権限がありません。
      </div>
    );
  }

  const { rows, total } = outcome.data;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (p: number) => {
    const params = new URLSearchParams();
    if (therapist) params.set("therapist", therapist);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return `/admin/history${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-adm-text">
          接客履歴
          {therapist && <span className="ml-2 text-sm font-normal text-adm-muted">（{therapist} に絞り込み中）</span>}
        </h1>
        <span className="text-sm text-adm-muted tabular-nums">全 {total} 件</span>
      </div>

      {therapist && (
        <Link href="/admin/history" className="text-sm text-adm-primary hover:underline">
          ← 絞り込みを解除（全セラピスト）
        </Link>
      )}

      {rows.length === 0 ? (
        <div className="py-16 text-center text-sm text-adm-muted">
          完了した接客の履歴はまだありません。
        </div>
      ) : (
        <div className="overflow-x-auto border border-adm-border" style={{ borderRadius: "4px" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-adm-border bg-adm-bg text-left">
                <th className="px-4 py-3 font-medium text-adm-text/60">日時</th>
                <th className="px-4 py-3 font-medium text-adm-text/60">セラピスト</th>
                <th className="px-4 py-3 font-medium text-adm-text/60">顧客</th>
                <th className="px-4 py-3 font-medium text-adm-text/60">コース</th>
                <th className="px-4 py-3 font-medium text-adm-text/60">エリア</th>
                <th className="px-4 py-3 text-right font-medium text-adm-text/60">金額</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.reservationId} className="border-b border-adm-border last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-adm-text tabular-nums">
                    {r.dateISO.slice(5).replace("-", "/")} {r.startHHmm}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/history?therapist=${r.therapistSlug}`}
                      className="text-adm-primary hover:underline"
                    >
                      {r.therapistName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-adm-text">{r.customerName ?? "—"}</td>
                  <td className="px-4 py-3 text-adm-text">{r.courseName}</td>
                  <td className="px-4 py-3 text-adm-muted">{r.areaName ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-adm-text">{YEN(r.totalAmount)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/reservations/${r.reservationId}`}
                      className="text-xs text-adm-primary hover:underline"
                    >
                      詳細 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 && (
        <div className="flex items-center justify-between">
          {page > 1 ? (
            <Link href={qs(page - 1)} className="border border-adm-border px-3 py-1.5 text-sm text-adm-text hover:border-adm-primary" style={{ borderRadius: "4px" }}>
              ← 前へ
            </Link>
          ) : <span />}
          <span className="text-sm text-adm-muted">{page} / {lastPage}</span>
          {page < lastPage ? (
            <Link href={qs(page + 1)} className="border border-adm-border px-3 py-1.5 text-sm text-adm-text hover:border-adm-primary" style={{ borderRadius: "4px" }}>
              次へ →
            </Link>
          ) : <span />}
        </div>
      )}
    </div>
  );
}
