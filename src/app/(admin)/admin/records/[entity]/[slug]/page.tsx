/**
 * /admin/records/[entity]/[slug] — 動的フォーム（spec 3-1 / フェーズ2）。
 *
 * - field_definitions から動的生成したフォームを表示
 * - entity_records.draft を保存する
 * - フィールド定義を追加すると、コード変更なしでフォームに新項目が出る
 * - 空状態・ローディング・エラーの3状態を実装（spec 12章）
 */

import { Suspense } from "react";
import Link from "next/link";
import { getFieldDefinitions } from "@/lib/cms/get-field-definitions";
import { getEntityRecord } from "@/lib/cms/get-entity-record";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import type { FieldDefinition, EntityRecord } from "@/domain/cms";
import { DynamicForm } from "./dynamic-form";

interface PageProps {
  params: Promise<{ entity: string; slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { entity, slug } = await params;
  return { title: `${entity} / ${slug} — 編集` };
}

// ローディング状態
function FormLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="読み込み中">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="space-y-1">
          <div className="h-4 w-24 bg-adm-border rounded animate-pulse" style={{ borderRadius: "4px" }} />
          <div className="h-9 bg-adm-border rounded animate-pulse" style={{ borderRadius: "4px" }} />
        </div>
      ))}
    </div>
  );
}

// エラー状態
function FormError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="p-4 border border-adm-danger text-adm-danger text-sm rounded"
      style={{ borderRadius: "4px" }}
    >
      <p className="font-medium">フォームの読み込みに失敗しました</p>
      <p className="mt-1 text-xs">{message}</p>
    </div>
  );
}

// 空状態（フィールド定義がない）
function FormEmpty({ entity }: { entity: string }) {
  return (
    <div className="py-12 text-center text-sm text-adm-text/60">
      <p>「{entity}」にはまだフィールド定義がありません。</p>
      <p className="mt-1">
        <Link href="/admin/fields" className="text-adm-primary underline hover:no-underline">
          フィールド定義管理
        </Link>
        から項目を追加してください。
      </p>
    </div>
  );
}

// フォームコンテンツ（サーバーコンポーネント）
async function FormContent({
  entity,
  slug,
}: {
  entity: string;
  slug: string;
}) {
  // 権限ガード（RLS が最後の砦だが、画面側でも can() を通す / spec 15章）
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return <FormError message="この画面を表示する権限がありません" />;
  }

  let defs: FieldDefinition[];
  let record: EntityRecord | null;

  try {
    [defs, record] = await Promise.all([
      getFieldDefinitions(entity),
      getEntityRecord(session, entity, slug),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return <FormError message={msg} />;
  }

  if (defs.length === 0) {
    return <FormEmpty entity={entity} />;
  }

  return (
    <DynamicForm
      entity={entity}
      slug={slug}
      defs={defs}
      initialDraft={record?.draft ?? {}}
      publishedAt={record?.publishedAt ?? null}
    />
  );
}

export default async function RecordEditPage({ params }: PageProps) {
  const { entity, slug } = await params;

  return (
    <div className="space-y-6">
      {/* ページヘッダー */}
      <div className="flex items-center gap-3">
        <Link
          href="/admin/records"
          className="text-sm text-adm-text/50 hover:text-adm-primary transition-colors"
        >
          ← レコード一覧
        </Link>
        <span className="text-adm-border">/</span>
        <h1 className="text-xl font-semibold text-adm-text">
          <span className="text-adm-text/50 font-normal">{entity}</span>
          {" / "}
          {slug}
        </h1>
      </div>

      {/* フォーム */}
      <div className="bg-adm-surface border border-adm-border rounded p-6" style={{ borderRadius: "4px" }}>
        <div className="mb-4 pb-4 border-b border-adm-border">
          <p className="text-xs text-adm-text/50">
            フィールド定義から自動生成されたフォームです。
            <Link href="/admin/fields" className="text-adm-primary hover:underline ml-1">
              フィールドを追加
            </Link>
            するとコード変更なしで新しい項目が現れます。
          </p>
        </div>
        <Suspense fallback={<FormLoading />}>
          <FormContent entity={entity} slug={slug} />
        </Suspense>
      </div>
    </div>
  );
}
