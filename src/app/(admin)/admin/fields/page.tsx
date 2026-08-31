/**
 * /admin/fields — 入力項目管理（spec 3-1 / フェーズ2）。
 *
 * - entity（therapist / course / area / page）を選んでフィールド一覧を表示
 * - フィールドを追加できる（key/label/type/options/sort_order/is_public/is_required/group_label）
 * - フィールドを非表示（論理削除）にできる
 * - 空状態・ローディング・エラーの3状態を実装（spec 12章）
 */

import { Suspense } from "react";
import Link from "next/link";
import { getFieldDefinitions } from "@/lib/cms/get-field-definitions";
import type { FieldDefinition } from "@/domain/cms";
import { FIELD_TYPES } from "@/domain/cms";
import { AddFieldForm } from "./add-field-form";
import { FieldList } from "./field-list";

export const metadata = { title: "入力項目" };

const ENTITIES = ["therapist", "course", "area", "page"] as const;
type Entity = (typeof ENTITIES)[number];

const ENTITY_LABELS: Record<Entity, string> = {
  therapist: "セラピスト",
  course: "コース",
  area: "エリア",
  page: "ページ",
};

// ローディング状態
function FieldsLoading() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="読み込み中">
      {[...Array(3)].map((_, i) => (
        <div
          key={i}
          className="h-12 bg-adm-border rounded animate-pulse"
          style={{ borderRadius: "4px" }}
        />
      ))}
    </div>
  );
}

// エラー状態
function FieldsError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="p-4 border border-adm-danger text-adm-danger text-sm rounded"
      style={{ borderRadius: "4px" }}
    >
      <p className="font-medium">入力項目の取得に失敗しました</p>
      <p className="mt-1 text-xs">{message}</p>
    </div>
  );
}

// 空状態
function FieldsEmpty({ entity }: { entity: string }) {
  return (
    <div className="py-12 text-center text-sm text-adm-text/60">
      <p>「{entity}」の入力項目がまだありません。</p>
      <p className="mt-1">下のフォームから最初のフィールドを追加してください。</p>
    </div>
  );
}

// フィールド一覧（サーバーコンポーネント）
async function FieldsContent({ entity }: { entity: Entity }) {
  let defs: FieldDefinition[];
  try {
    defs = await getFieldDefinitions(entity);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return <FieldsError message={msg} />;
  }

  if (defs.length === 0) {
    return <FieldsEmpty entity={ENTITY_LABELS[entity]} />;
  }

  return <FieldList defs={defs} />;
}

export default async function FieldsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  const rawEntity = params["entity"] ?? "therapist";
  const entity: Entity = (ENTITIES as readonly string[]).includes(rawEntity)
    ? (rawEntity as Entity)
    : "therapist";

  return (
    <div className="space-y-6">
      {/* ページヘッダー */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-adm-text">入力項目</h1>
        <p className="text-xs text-adm-text/60">
          項目を追加するとフォームに自動で反映されます（コード変更不要）
        </p>
      </div>

      {/* entity 選択タブ */}
      <div
        className="flex gap-1 p-1 bg-adm-bg border border-adm-border rounded"
        role="tablist"
        aria-label="エンティティ選択"
        style={{ borderRadius: "4px" }}
      >
        {ENTITIES.map((e) => (
          <Link
            key={e}
            href={`/admin/fields?entity=${e}`}
            role="tab"
            aria-selected={e === entity}
            className={[
              "px-4 py-1.5 text-sm rounded transition-colors",
              e === entity
                ? "bg-adm-surface text-adm-primary font-medium border border-adm-border"
                : "text-adm-text/60 hover:text-adm-text",
            ].join(" ")}
            style={{ borderRadius: "4px" }}
          >
            {ENTITY_LABELS[e]}
          </Link>
        ))}
      </div>

      {/* フィールド一覧 */}
      <section>
        <h2 className="text-sm font-medium text-adm-text mb-3">
          {ENTITY_LABELS[entity]} のフィールド一覧
        </h2>
        <Suspense fallback={<FieldsLoading />}>
          <FieldsContent entity={entity} />
        </Suspense>
      </section>

      {/* フィールド追加フォーム */}
      <section className="border-t border-adm-border pt-6">
        <h2 className="text-sm font-medium text-adm-text mb-4">フィールドを追加</h2>
        <AddFieldForm entity={entity} fieldTypes={FIELD_TYPES} />
      </section>
    </div>
  );
}
