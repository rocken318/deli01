"use client";

/**
 * フィールド定義一覧（クライアントコンポーネント）。
 * - 非表示（論理削除）/ 復元ボタン
 * - 削除済みフィールドも表示（薄くして識別）
 */

import { useTransition } from "react";
import { toggleFieldVisibility } from "@/lib/cms/actions";
import type { FieldDefinition } from "@/domain/cms";

const FIELD_TYPE_LABELS: Record<string, string> = {
  text: "テキスト",
  textarea: "テキストエリア",
  rich_text: "リッチテキスト",
  number: "数値",
  money: "金額（円）",
  boolean: "真偽値",
  select: "セレクト",
  multi_select: "複数選択",
  tag: "タグ",
  date: "日付",
  url: "URL",
  image: "画像",
  image_gallery: "画像ギャラリー",
};

export function FieldList({ defs }: { defs: FieldDefinition[] }) {
  return (
    <div className="overflow-hidden border border-adm-border rounded" style={{ borderRadius: "4px" }}>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-adm-bg border-b border-adm-border">
            <th className="px-4 py-2 text-left font-medium text-adm-text/60 w-8">#</th>
            <th className="px-4 py-2 text-left font-medium text-adm-text/60">key</th>
            <th className="px-4 py-2 text-left font-medium text-adm-text/60">ラベル</th>
            <th className="px-4 py-2 text-left font-medium text-adm-text/60">型</th>
            <th className="px-4 py-2 text-left font-medium text-adm-text/60">グループ</th>
            <th className="px-4 py-2 text-center font-medium text-adm-text/60">公開</th>
            <th className="px-4 py-2 text-center font-medium text-adm-text/60">必須</th>
            <th className="px-4 py-2 text-right font-medium text-adm-text/60">操作</th>
          </tr>
        </thead>
        <tbody>
          {defs.map((def, idx) => (
            <FieldRow key={def.id} def={def} index={idx + 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FieldRow({ def, index }: { def: FieldDefinition; index: number }) {
  const [isPending, startTransition] = useTransition();
  const isDeleted = def.deletedAt !== null;

  const handleToggle = () => {
    startTransition(async () => {
      const result = await toggleFieldVisibility(def.id, !isDeleted);
      if (!result.ok) {
        alert(result.error ?? "操作に失敗しました");
      }
    });
  };

  return (
    <tr
      className={[
        "border-b border-adm-border last:border-b-0 hover:bg-adm-bg/50 transition-colors",
        isDeleted ? "opacity-40" : "",
      ].join(" ")}
    >
      <td className="px-4 py-3 text-adm-text/40 text-xs">{index}</td>
      <td className="px-4 py-3 font-mono text-xs text-adm-text/80">{def.key}</td>
      <td className="px-4 py-3">
        <span className="font-medium">{def.label}</span>
        {def.helpText && (
          <span className="block text-xs text-adm-text/50 mt-0.5">{def.helpText}</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="px-2 py-0.5 text-xs bg-adm-bg border border-adm-border rounded">
          {FIELD_TYPE_LABELS[def.type] ?? def.type}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-adm-text/60">{def.groupLabel ?? "—"}</td>
      <td className="px-4 py-3 text-center">
        <span aria-label={def.isPublic ? "公開" : "非公開"}>
          {def.isPublic ? "✓" : "—"}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        <span aria-label={def.isRequired ? "必須" : "任意"}>
          {def.isRequired ? "✓" : "—"}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={handleToggle}
          disabled={isPending}
          className={[
            "px-3 py-1 text-xs rounded border transition-colors",
            isDeleted
              ? "border-adm-primary text-adm-primary hover:bg-adm-primary hover:text-white"
              : "border-adm-border text-adm-text/60 hover:border-adm-danger hover:text-adm-danger",
            isPending ? "opacity-50 cursor-not-allowed" : "",
          ].join(" ")}
          style={{ borderRadius: "4px" }}
          aria-label={isDeleted ? `${def.label} を復元` : `${def.label} を非表示`}
        >
          {isPending ? "処理中..." : isDeleted ? "復元" : "非表示"}
        </button>
      </td>
    </tr>
  );
}
