import type { DisplayValue } from "@/lib/public/therapist-view";

/**
 * 表示フィールド値のレンダラー（spec 2-2: field_definitions 駆動）。
 * 日本語リテラルを持たない。単位語（「年」「円」等）は付けず、値のみ描画する
 * （ラベルは field_definitions.label が担う）。金額は ¥ 記号（記号は可）。
 */
export function FieldValue({ value }: { value: DisplayValue }) {
  switch (value.kind) {
    case "text":
      return <p className="whitespace-pre-wrap leading-relaxed">{value.text}</p>;
    case "html":
      // rich_text: strip tags to prevent XSS on the public side.
      return <p className="whitespace-pre-wrap leading-relaxed">{value.html.replace(/<[^>]*>/g, "")}</p>;
    case "number":
      return <span className="font-mono text-pub-text">{value.num.toLocaleString("en-US")}</span>;
    case "money":
      return (
        <span className="font-mono text-pub-primary">
          {"¥"}
          {value.amount.toLocaleString("en-US")}
        </span>
      );
    case "boolean":
      // 真偽は記号で表す（日本語を使わない）
      return <span className="font-mono">{value.bool ? "✓" : "—"}</span>;
    case "tags":
      return (
        <ul className="flex flex-wrap gap-1.5">
          {value.tags.map((t) => (
            <li key={t} className="rounded border border-pub-border px-2 py-0.5 text-xs text-pub-subtext">
              {t}
            </li>
          ))}
        </ul>
      );
    case "url":
      return (
        <a href={value.url} className="text-pub-primary underline underline-offset-4" rel="noopener noreferrer" target="_blank">
          {value.url}
        </a>
      );
    default:
      return null;
  }
}
