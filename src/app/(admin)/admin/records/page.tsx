/**
 * /admin/records — レコード一覧（entity 選択 → slug 入力 → フォームへ）。
 */

import Link from "next/link";
import { RecordOpenForm } from "./record-open-form";

export const metadata = { title: "レコード" };

const ENTITIES = ["therapist", "course", "area", "page"] as const;
type Entity = (typeof ENTITIES)[number];

const ENTITY_LABELS: Record<Entity, string> = {
  therapist: "セラピスト",
  course: "コース",
  area: "エリア",
  page: "ページ",
};

export default function RecordsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-adm-text">レコード</h1>

      <p className="text-sm text-adm-text/60">
        編集したいエンティティと slug を指定してください。
      </p>

      {/* entity ごとのナビゲーション */}
      <div className="grid grid-cols-2 gap-4">
        {ENTITIES.map((entity) => (
          <div
            key={entity}
            className="bg-adm-surface border border-adm-border rounded p-4 space-y-3"
            style={{ borderRadius: "4px" }}
          >
            <h2 className="text-sm font-medium text-adm-text">
              {ENTITY_LABELS[entity]}
            </h2>
            <RecordOpenForm entity={entity} />
          </div>
        ))}
      </div>

      <div className="border-t border-adm-border pt-4">
        <p className="text-xs text-adm-text/40">
          フィールド定義は
          <Link href="/admin/fields" className="text-adm-primary hover:underline mx-1">
            フィールド定義管理
          </Link>
          で確認・追加できます。
        </p>
      </div>
    </div>
  );
}
