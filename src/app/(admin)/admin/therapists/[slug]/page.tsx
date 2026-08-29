/**
 * /admin/therapists/[slug] — セラピスト詳細・編集（spec 3-7・3-8 / フェーズ4）。
 *
 * - 内部情報フォーム（status / display_order / app_user_id）
 * - フィールド定義駆動の動的プロフィールフォーム（entity_records）
 * - 公開ボタン（掲載同意ゲート）
 * - 退職ボタン（一括非公開）
 * - プレビューリンク
 */

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { getFieldDefinitions } from "@/lib/cms/get-field-definitions";
import { getEntityRecord } from "@/lib/cms/get-entity-record";
import { getTherapistBySlug } from "@/domain/cms/therapist-actions";
import type { FieldDefinition, EntityRecord } from "@/domain/cms";
import type { TherapistListItem } from "@/domain/cms/therapist-actions";
import { TherapistInternalForm } from "./therapist-internal-form";
import { TherapistPublishButton } from "./therapist-publish-button";
import { TherapistRetireButton } from "./therapist-retire-button";
import { DynamicForm } from "../../records/[entity]/[slug]/dynamic-form";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  return { title: `セラピスト: ${slug} — 編集` };
}

// ---------------------------------------------------------------------------
// ローディング状態
// ---------------------------------------------------------------------------

function PageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="読み込み中">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="h-24 bg-adm-border rounded animate-pulse" style={{ borderRadius: "4px" }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// エラー状態
// ---------------------------------------------------------------------------

function PageError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="p-4 border border-adm-danger text-adm-danger text-sm rounded"
      style={{ borderRadius: "4px" }}
    >
      <p className="font-medium">ページの読み込みに失敗しました</p>
      <p className="mt-1 text-xs">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// コンテンツ（サーバーコンポーネント）
// ---------------------------------------------------------------------------

async function TherapistDetailContent({ slug }: { slug: string }) {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return <PageError message="この画面を表示する権限がありません" />;
  }

  let therapist: TherapistListItem | null;
  let defs: FieldDefinition[];
  let record: EntityRecord | null;

  try {
    [therapist, defs, record] = await Promise.all([
      getTherapistBySlug(slug),
      getFieldDefinitions("therapist"),
      getEntityRecord(session, "therapist", slug),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return <PageError message={msg} />;
  }

  if (!therapist) {
    notFound();
  }

  const isRetired = therapist.status === "retired";

  return (
    <div className="space-y-6">
      {/* 退職済みバナー */}
      {isRetired && (
        <div
          role="alert"
          className="p-4 bg-[#B4453C]/5 border border-[#B4453C]/20 text-[#B4453C] text-sm rounded"
          style={{ borderRadius: "4px" }}
        >
          このセラピストは退職済みです。プロフィールは非公開になっています。
        </div>
      )}

      {/* セクション: 内部情報 */}
      <div className="bg-adm-surface border border-adm-border rounded p-6" style={{ borderRadius: "4px" }}>
        <h2 className="text-sm font-semibold text-adm-text/60 uppercase tracking-wider mb-4 pb-3 border-b border-adm-border">
          内部情報
        </h2>
        <TherapistInternalForm therapist={therapist} />
      </div>

      {/* セクション: プロフィール（動的フォーム） */}
      <div className="bg-adm-surface border border-adm-border rounded p-6" style={{ borderRadius: "4px" }}>
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-adm-border">
          <h2 className="text-sm font-semibold text-adm-text/60 uppercase tracking-wider">
            プロフィール
          </h2>
          <Link
            href="/admin/fields"
            className="text-xs text-adm-primary hover:underline"
          >
            フィールドを管理
          </Link>
        </div>

        {defs.length === 0 ? (
          <div className="py-8 text-center text-sm text-adm-text/60">
            <p>「therapist」にはまだフィールド定義がありません。</p>
            <p className="mt-1">
              <Link href="/admin/fields" className="text-adm-primary underline hover:no-underline">
                フィールド定義管理
              </Link>
              から項目を追加してください。
            </p>
          </div>
        ) : (
          <DynamicForm
            entity="therapist"
            slug={slug}
            defs={defs}
            initialDraft={record?.draft ?? {}}
            publishedAt={record?.publishedAt ?? null}
          />
        )}
      </div>

      {/* セクション: 公開・退職アクション */}
      {!isRetired && (
        <div className="bg-adm-surface border border-adm-border rounded p-6" style={{ borderRadius: "4px" }}>
          <h2 className="text-sm font-semibold text-adm-text/60 uppercase tracking-wider mb-4 pb-3 border-b border-adm-border">
            公開・退職
          </h2>
          <div className="flex flex-wrap items-center gap-4">
            {/* 公開ボタン（掲載同意ゲート） */}
            <TherapistPublishButton slug={slug} publishedAt={record?.publishedAt ?? null} />

            {/* プレビューリンク */}
            <Link
              href={`/therapists/${slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 text-sm border border-adm-border text-adm-text rounded hover:border-adm-primary hover:text-adm-primary transition-colors"
              style={{ borderRadius: "4px" }}
            >
              公開プレビュー →
            </Link>

            {/* 退職ボタン（危険操作） */}
            <div className="ml-auto">
              <TherapistRetireButton slug={slug} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ページ
// ---------------------------------------------------------------------------

export default async function TherapistDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const isNew = slug === "new";

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-center gap-3">
        <Link
          href="/admin/therapists"
          className="text-sm text-adm-text/50 hover:text-adm-primary transition-colors"
        >
          ← セラピスト一覧
        </Link>
        <span className="text-adm-border">/</span>
        <h1 className="text-xl font-semibold text-adm-text">
          {isNew ? "新規セラピスト" : slug}
        </h1>
      </div>

      {isNew ? (
        <div className="bg-adm-surface border border-adm-border rounded p-6" style={{ borderRadius: "4px" }}>
          <TherapistInternalForm therapist={null} />
        </div>
      ) : (
        <Suspense fallback={<PageLoading />}>
          <TherapistDetailContent slug={slug} />
        </Suspense>
      )}
    </div>
  );
}
