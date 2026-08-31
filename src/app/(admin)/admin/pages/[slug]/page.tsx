import type { Metadata } from "next";

export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getPage, savePageFields, savePageBlocks, publishPage } from "@/lib/cms/pages-actions";
import type { PublishPageResult } from "@/lib/cms/pages-actions";
import { listMedia } from "@/lib/cms/media-actions";
import { getDevSession } from "@/lib/cms/dev-session";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/cms/actions";
import type { HeroBlock, PlayBlock } from "@/domain/cms/blocks";
import { PublishForm } from "./publish-form";
import { PlayEditor } from "./play-editor";
import { HeroImageEditor } from "./hero-image-editor";

export const metadata: Metadata = { title: "ページ編集" };

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ saved?: string }>;
}

export default async function PageEditorPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { saved } = await searchParams;

  // 機微データの露出防止（本番・未 Auth では 403 相当）。
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return (
      <div className="bg-adm-surface border border-adm-border rounded p-6">
        <p className="text-sm text-adm-text">権限がありません。</p>
      </div>
    );
  }

  const page = await getPage(slug, "ja");

  if (!page) {
    notFound();
  }

  const mediaItems = await listMedia();

  const fields = page.draftFields as {
    heading?: string;
    lead?: string;
    heroImageId?: string | null;
    seoTitle?: string;
    seoDescription?: string;
  };

  const heroBlock = page.draftBlocks.find((b): b is HeroBlock => b.type === "hero");
  const playBlock = page.draftBlocks.find((b): b is PlayBlock => b.type === "play");

  async function handleSaveFields(formData: FormData) {
    "use server";
    // heroImageId は hero ブロックの imageId 側に一本化したため、ここでは触らない。
    // 既存の heroImageId を据え置いて（保存して）意図せず消さないようにする。
    await savePageFields(
      slug,
      {
        heading: formData.get("heading") as string ?? "",
        lead: formData.get("lead") as string ?? "",
        heroImageId: (fields.heroImageId ?? null),
        seoTitle: formData.get("seoTitle") as string ?? "",
        seoDescription: formData.get("seoDescription") as string ?? "",
      },
      "ja",
    );
    revalidatePath(`/admin/pages/${slug}`);
    redirect(`/admin/pages/${slug}?saved=fields`);
  }

  async function handleSaveHeroHeading(formData: FormData) {
    "use server";
    const newHeading = formData.get("heroHeading") as string ?? "";
    const currentPage = await getPage(slug, "ja");
    if (!currentPage) return;
    const hasHero = currentPage.draftBlocks.some((b) => b.type === "hero");
    if (!hasHero) {
      // hero ブロックがなければ先頭に追加する
      const newHeroBlock = {
        id: `${slug}-hero-1`,
        type: "hero" as const,
        visible: true,
        heading: newHeading,
        subheading: "",
        imageId: null,
        ctaLabel: "",
        ctaHref: "",
      };
      await savePageBlocks(slug, [newHeroBlock, ...currentPage.draftBlocks], "ja");
    } else {
      const updatedBlocks = currentPage.draftBlocks.map((b) =>
        b.type === "hero" ? { ...b, heading: newHeading } : b,
      );
      await savePageBlocks(slug, updatedBlocks, "ja");
    }
    revalidatePath(`/admin/pages/${slug}`);
    redirect(`/admin/pages/${slug}?saved=heading`);
  }

  async function handlePublish(
    _prev: ActionResult<PublishPageResult>,
    formData: FormData,
  ): Promise<ActionResult<PublishPageResult>> {
    "use server";
    void formData;
    return publishPage(slug, "ja");
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

      {saved && (
        <div className="rounded border border-adm-primary bg-adm-primary/10 px-4 py-2 text-sm text-adm-primary">
          保存しました。「このページを公開する」ボタンを押すと公開に反映されます。
        </div>
      )}

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

          {/* ヒーロー画像（アップロード＋選択を内蔵 / spec 3-7） */}
          <div className="pt-2">
            <p className="mb-2 text-sm text-adm-text">ヒーロー画像</p>
            <HeroImageEditor
              slug={slug}
              initialImageId={heroBlock.imageId}
              initialMedia={mediaItems.map((m) => ({ id: m.id, url: m.url, alt: m.alt }))}
            />
          </div>
        </section>
      )}

      {/* プレイ内容エディタ（繰り返し項目・＋ボタンで追加） */}
      <section className="bg-adm-surface border border-adm-border rounded p-6 space-y-4">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2">
          プレイ内容
        </h2>
        <PlayEditor
          slug={slug}
          initialHeading={playBlock?.heading ?? ""}
          initialItems={playBlock?.items ?? []}
        />
      </section>

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

      {/* 公開ボタン + 禁止語警告表示（spec 13-2） */}
      <section className="bg-adm-surface border border-adm-border rounded p-6">
        <h2 className="text-base font-semibold text-adm-text border-b border-adm-border pb-2 mb-4">
          公開
        </h2>
        <PublishForm action={handlePublish} />
      </section>
    </div>
  );
}
