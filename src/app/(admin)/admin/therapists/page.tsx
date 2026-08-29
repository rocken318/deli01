/**
 * /admin/therapists — セラピスト一覧（spec 3-8 / フェーズ4）。
 *
 * - slug / status / display_order を表示
 * - 上下ボタンで表示順を変更（updateTherapistOrder）
 * - 「新規追加」リンク
 * - 空状態・ローディング・エラーの3状態（spec 12章）
 * - デザイントークン: 管理側（spec 12-2）
 */

import { Suspense } from "react";
import Link from "next/link";
import { listTherapists } from "@/domain/cms/therapist-actions";
import { TherapistReorderButtons } from "./therapist-reorder-buttons";

export const metadata = { title: "セラピスト管理" };

// ---------------------------------------------------------------------------
// ステータスバッジ
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: "active" | "inactive" | "retired" }) {
  const styles: Record<string, string> = {
    active: "bg-[#3F7A6B]/10 text-[#3F7A6B] border border-[#3F7A6B]/20",
    inactive: "bg-[#C98A2B]/10 text-[#C98A2B] border border-[#C98A2B]/20",
    retired: "bg-[#B4453C]/10 text-[#B4453C] border border-[#B4453C]/20",
  };
  const labels: Record<string, string> = {
    active: "稼働中",
    inactive: "非稼働",
    retired: "退職",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}
      style={{ borderRadius: "4px" }}
    >
      {labels[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ローディング状態
// ---------------------------------------------------------------------------

function ListLoading() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="読み込み中">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="h-14 bg-adm-border rounded animate-pulse" style={{ borderRadius: "4px" }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 空状態
// ---------------------------------------------------------------------------

function ListEmpty() {
  return (
    <div className="py-16 text-center text-sm text-adm-text/60">
      <p>セラピストが登録されていません。</p>
      <p className="mt-2">
        <Link
          href="/admin/therapists/new"
          className="text-adm-primary underline hover:no-underline"
        >
          新規セラピストを追加
        </Link>
        してください。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// エラー状態
// ---------------------------------------------------------------------------

function ListError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="p-4 border border-adm-danger text-adm-danger text-sm rounded"
      style={{ borderRadius: "4px" }}
    >
      <p className="font-medium">一覧の読み込みに失敗しました</p>
      <p className="mt-1 text-xs">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 一覧コンテンツ（サーバーコンポーネント）
// ---------------------------------------------------------------------------

async function TherapistListContent() {
  let therapists: Awaited<ReturnType<typeof listTherapists>>;

  try {
    therapists = await listTherapists();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return <ListError message={msg} />;
  }

  if (therapists.length === 0) {
    return <ListEmpty />;
  }

  return (
    <div className="border border-adm-border rounded overflow-hidden" style={{ borderRadius: "4px" }}>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-adm-bg border-b border-adm-border">
            <th className="px-4 py-3 text-left font-medium text-adm-text/60">表示順</th>
            <th className="px-4 py-3 text-left font-medium text-adm-text/60">slug</th>
            <th className="px-4 py-3 text-left font-medium text-adm-text/60">ステータス</th>
            <th className="px-4 py-3 text-left font-medium text-adm-text/60">操作</th>
            <th className="px-4 py-3 text-right font-medium text-adm-text/60">並べ替え</th>
          </tr>
        </thead>
        <tbody>
          {therapists.map((t, index) => (
            <tr
              key={t.id}
              className="border-b border-adm-border last:border-0 hover:bg-adm-bg/50 transition-colors"
            >
              <td className="px-4 py-3 text-adm-text/60 tabular-nums">{t.displayOrder}</td>
              <td className="px-4 py-3">
                <Link
                  href={`/admin/therapists/${t.slug}`}
                  className="font-medium text-adm-primary hover:underline"
                >
                  {t.slug}
                </Link>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={t.status} />
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/admin/therapists/${t.slug}`}
                    className="text-xs px-2 py-1 border border-adm-border rounded hover:border-adm-primary hover:text-adm-primary transition-colors"
                    style={{ borderRadius: "4px" }}
                  >
                    編集
                  </Link>
                  <Link
                    href={`/admin/records/therapist/${t.slug}`}
                    className="text-xs px-2 py-1 border border-adm-border rounded hover:border-adm-primary hover:text-adm-primary transition-colors"
                    style={{ borderRadius: "4px" }}
                  >
                    プロフィール
                  </Link>
                </div>
              </td>
              <td className="px-4 py-3 text-right">
                <TherapistReorderButtons
                  therapists={therapists}
                  currentIndex={index}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ページ
// ---------------------------------------------------------------------------

export default function TherapistsPage() {
  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-adm-text">セラピスト管理</h1>
        <Link
          href="/admin/therapists/new"
          className="px-4 py-2 text-sm font-medium bg-adm-primary text-white rounded hover:bg-adm-primary/90 transition-colors"
          style={{ borderRadius: "4px" }}
        >
          新規追加
        </Link>
      </div>

      {/* 一覧 */}
      <div className="bg-adm-surface">
        <Suspense fallback={<ListLoading />}>
          <TherapistListContent />
        </Suspense>
      </div>
    </div>
  );
}
