/**
 * /admin/records — コンテンツ管理（#2 直感UX）。
 *
 * 種別（セラピスト/コース/エリア）ごとに既存コンテンツを一覧し、
 * 「名前を入力して追加」だけで新規レコードを作れる（slug はサーバー自動採番）。
 * ページはレイアウトが特殊なため専用エディタ（/admin/pages）へ誘導する。
 */

import Link from "next/link";
import { listEntityRecords } from "@/lib/cms/actions";
import { RecordQuickAdd } from "./record-quick-add";

export const metadata = { title: "コンテンツ" };

// entity_records で管理する種別（page は専用エディタへ）
const ENTITIES = ["therapist", "course", "area"] as const;
type Entity = (typeof ENTITIES)[number];

const ENTITY_LABELS: Record<Entity, string> = {
  therapist: "セラピスト",
  course: "コース",
  area: "エリア",
};

export const dynamic = "force-dynamic";

async function EntityCard({ entity }: { entity: Entity }) {
  const result = await listEntityRecords(entity);
  const records = result.ok && result.data ? result.data : [];

  return (
    <section
      className="bg-adm-surface border border-adm-border rounded p-4 space-y-3"
      style={{ borderRadius: "4px" }}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-adm-text">{ENTITY_LABELS[entity]}</h2>
        <span className="text-xs text-adm-text/40">{records.length}件</span>
      </div>

      <RecordQuickAdd entity={entity} />

      {!result.ok ? (
        <p role="alert" className="text-xs text-adm-danger">
          一覧の取得に失敗しました（{result.error}）
        </p>
      ) : records.length === 0 ? (
        <p className="text-xs text-adm-text/40">
          まだありません。上の欄に名前を入れて追加してください。
        </p>
      ) : (
        <ul className="divide-y divide-adm-border border border-adm-border rounded" style={{ borderRadius: "4px" }}>
          {records.map((r) => (
            <li key={r.slug}>
              <Link
                href={`/admin/records/${entity}/${encodeURIComponent(r.slug)}`}
                className="flex items-center justify-between px-3 py-2 text-sm hover:bg-adm-bg"
              >
                <span className="text-adm-text">{r.name}</span>
                <span className="flex items-center gap-2">
                  {r.publishedAt ? (
                    <span className="text-xs text-adm-primary">公開中</span>
                  ) : (
                    <span className="text-xs text-adm-text/40">下書き</span>
                  )}
                  <span className="text-xs text-adm-text/30">{r.slug}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function RecordsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-adm-text">コンテンツ</h1>

      <p className="text-sm text-adm-text/60">
        種別ごとに、名前を入力するだけで追加できます。追加後の編集画面で残りの項目を埋めてください。
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {ENTITIES.map((entity) => (
          <EntityCard key={entity} entity={entity} />
        ))}
      </div>

      <div className="border-t border-adm-border pt-4 space-y-1">
        <p className="text-xs text-adm-text/40">
          ページ（トップ等）の編集は
          <Link href="/admin/pages" className="text-adm-primary hover:underline mx-1">
            ページ管理
          </Link>
          から行えます。
        </p>
        <p className="text-xs text-adm-text/40">
          表示する項目の追加・編集は
          <Link href="/admin/fields" className="text-adm-primary hover:underline mx-1">
            入力項目
          </Link>
          で行えます。
        </p>
      </div>
    </div>
  );
}
