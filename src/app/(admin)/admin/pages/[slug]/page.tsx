import type { Metadata } from "next";

export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getPage, savePageFields, savePageBlocks, publishPage } from "@/lib/cms/pages-actions";
import type { HeroBlock } from "@/domain/cms/blocks";

export const metadata: Metadata = { title: "ページ編集" };

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function PageEditorPage({ params }: Props) {
  const { slug } = await params;
  const page = await getPage(slug, "ja");

  if (!page) {
    notFound();
  }

  const fields = page.draftFields as {
    heading?: string;
    lead?: string;
    heroImageId?: string | null;
    seoTitle?: string;
    seoDescription?: string;
  };

  const heroBlock = page.draftBlocks.find((b): b is HeroBlock => b.type === "hero");

  async function handleSaveFields(formData: FormData) {
    "use server";
    await savePageFields(
      slug,
      {
        heading: formData.get("heading") as string ?? "",
        lead: formData.get("lead") as string ?? "",
        heroImageId: null,
        seoTitle: formData.get("seoTitle") as string ?? "",
        seoDescription: formData.get("seoDescription") as string ?? "",
      },
      "ja",
    );
  }

  async function handleSaveHeroHeading(formData: FormData) {
    "use server";
    const newHeading = formData.get("heroHeading") as string ?? "";
    // Update the hero block heading while preserving all other blocks
    const currentPage = await getPage(slug, "ja");
    if (!currentPage) return;
    const updatedBlocks = currentPage.draftBlocks.map((b) => {
      if (b.type === "hero") {
        return { ...b, heading: newHeading };
      }
      return b;
    });
    await savePageBlocks(slug, updatedBlocks, "ja");
  }

  async function handlePublish(formData: FormData) {
    "use server";
    void formData;
    await publishPage(slug, "ja");
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-adm-text">
          ページ編集: <span className="font-mono text-adm-primary">{slug}</span>
        </h1>
        {page.publishedAt && (
          <span className="text-sm text-adm-text opacity-60">
            公開済み: {new Date(page.publishedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
          </span>
        )}
      </div>

      {/* ページフィールドフォーム */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">ページ基本設定</h2>
        <form action={handleSaveFields} className="space-y-4">
          <div className="flex items-start gap-3">
            <label htmlFor="heading" className="w-40 text-sm text-adm-text shrink-0 pt-1.5">
              見出し
            </label>
            <input
              id="heading"
              name="heading"
              defaultValue={fields.heading ?? ""}
              className="flex-1 border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
            />
          </div>
          <div className="flex items-start gap-3">
            <label htmlFor="lead" className="w-40 text-sm text-adm-text shrink-0 pt-1.5">
              リード文
            </label>
            <textarea
              id="lead"
              name="lead"
              rows={3}
              defaultValue={fields.lead ?? ""}
              className="flex-1 border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary resize-none"
            />
          </div>
          <div className="flex items-start gap-3">
            <label htmlFor="seoTitle" className="w-40 text-sm text-adm-text shrink-0 pt-1.5">
              SEO タイトル
            </label>
            <input
              id="seoTitle"
              name="seoTitle"
              defaultValue={fields.seoTitle ?? ""}
              className="flex-1 border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
            />
          </div>
          <div className="flex items-start gap-3">
            <label htmlFor="seoDescription" className="w-40 text-sm text-adm-text shrink-0 pt-1.5">
              SEO 説明
            </label>
            <textarea
              id="seoDescription"
              name="seoDescription"
              rows={2}
              defaultValue={fields.seoDescription ?? ""}
              className="flex-1 border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary resize-none"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="px-4 py-2 text-sm bg-adm-primary text-white rounded hover:opacity-90"
            >
              フィールドを保存
            </button>
          </div>
        </form>
      </section>

      {/* ヒーローブロック見出し編集（完成条件） */}
      {heroBlock && (
        <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
          <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
            ヒーローブロック見出し
          </h2>
          <form action={handleSaveHeroHeading} className="flex items-center gap-3">
            <label htmlFor="heroHeading" className="w-40 text-sm text-adm-text shrink-0">
              見出しテキスト
            </label>
            <input
              id="heroHeading"
              name="heroHeading"
              defaultValue={heroBlock.heading}
              className="flex-1 border border-adm-border rounded px-3 py-1.5 text-sm bg-adm-bg text-adm-text focus:outline-none focus:border-adm-primary"
            />
            <button
              type="submit"
              className="px-3 py-1.5 text-sm bg-adm-primary text-white rounded hover:opacity-90"
            >
              保存
            </button>
          </form>
        </section>
      )}

      {/* ブロック一覧（読み取り専用） */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          ブロック構成 ({page.draftBlocks.length} 件)
        </h2>
        {page.draftBlocks.length === 0 ? (
          <p className="text-sm text-adm-text opacity-60">ブロックがありません</p>
        ) : (
          <ul className="space-y-2">
            {page.draftBlocks.map((block, i) => {
              const label = "heading" in block && block.heading
                ? block.heading
                : "label" in block && block.label
                  ? block.label
                  : "body" in block && block.body
                    ? String(block.body).slice(0, 40)
                    : "(内容なし)";
              return (
                <li
                  key={block.id}
                  className="flex items-center gap-3 px-3 py-2 bg-adm-bg border border-adm-border rounded text-sm"
                >
                  <span className="text-adm-text opacity-40 w-5 text-right">{i + 1}</span>
                  <span className="font-mono text-xs text-adm-primary bg-adm-surface border border-adm-border px-1.5 py-0.5 rounded">
                    {block.type}
                  </span>
                  <span className="text-adm-text flex-1">{label}</span>
                  {!block.visible && (
                    <span className="text-xs text-adm-caution">非表示</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 公開ボタン */}
      <section className="bg-adm-surface border border-adm-border rounded p-6">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2 mb-4">
          公開
        </h2>
        <form action={handlePublish}>
          <button
            type="submit"
            className="px-6 py-2 text-sm bg-adm-primary text-white rounded hover:opacity-90 font-medium"
          >
            このページを公開する
          </button>
          <p className="mt-2 text-xs text-adm-text opacity-60">
            公開すると draft の内容が published に反映されます。禁止語チェックは警告のみ（ブロックしません）。
          </p>
        </form>
      </section>
    </div>
  );
}
