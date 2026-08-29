import type { Metadata } from "next";
import Link from "next/link";
import { listPages } from "@/lib/cms/pages-actions";

export const metadata: Metadata = { title: "固定ページ" };

export default async function PagesListPage() {
  const pages = await listPages("ja");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-adm-text">固定ページ一覧</h1>

      <div className="bg-adm-surface border border-adm-border rounded">
        {pages.length === 0 ? (
          <p className="p-6 text-sm text-adm-text opacity-60">ページがありません</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-adm-border">
              <tr>
                <th className="text-left px-4 py-3 text-adm-text font-medium">スラッグ</th>
                <th className="text-left px-4 py-3 text-adm-text font-medium">公開日時</th>
                <th className="text-left px-4 py-3 text-adm-text font-medium">更新日時</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-adm-border">
              {pages.map((p) => (
                <tr key={p.id} className="hover:bg-adm-bg">
                  <td className="px-4 py-3 font-mono text-adm-text">{p.slug}</td>
                  <td className="px-4 py-3 text-adm-text">
                    {p.publishedAt
                      ? new Date(p.publishedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
                      : <span className="text-adm-caution">未公開</span>}
                  </td>
                  <td className="px-4 py-3 text-adm-text">
                    {new Date(p.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/pages/${p.slug}`}
                      className="px-3 py-1 text-sm bg-adm-primary text-white rounded hover:opacity-90"
                    >
                      編集
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
