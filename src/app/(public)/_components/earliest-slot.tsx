/**
 * 署名要素「最短 HH:MM から案内可能」（spec 12-1）。
 *
 * このサービスが顧客に約束しているのは結局その一点なので、デザインの主役に置く。
 * 大きく・金色・等幅。値（時刻）は空き枠エンジン（spec 5章 / フェーズ9）実装後に入る。
 * 本フェーズは値なし＝placeholder（CMS 由来の文言）を等幅で出すだけ。
 *
 * 文言はすべて content レイヤ経由（labels）。日本語リテラルを持たない。
 * - template: 「最短 {time} から案内可能」のような雛形（{time} を time で差し替え）
 * - placeholder: 値未確定時に time の位置に出す文字（例: 「調整中」）
 */
export function EarliestSlot({
  template,
  placeholder,
  time,
  size = "lg",
}: {
  /** 例: "最短 {time} から案内可能"（CMS labels.earliest_slot_template） */
  template: string;
  /** 値未確定時に {time} へ差し込む文言（CMS labels.earliest_slot_pending） */
  placeholder: string;
  /** 確定時刻（Phase9 まで null） */
  time?: string | null;
  size?: "lg" | "sm";
}) {
  // テンプレートが無い場合は描画しない（日本語のハードコード回避）
  if (!template) return null;

  const value = time ?? placeholder;
  const [before, after] = template.includes("{time}")
    ? template.split("{time}")
    : [template, ""];

  const valueClass =
    size === "lg"
      ? "font-mono text-2xl font-medium text-pub-primary"
      : "font-mono text-lg font-medium text-pub-primary";

  return (
    <p
      className={
        size === "lg"
          ? "text-sm text-pub-subtext"
          : "text-xs text-pub-subtext"
      }
    >
      {before}
      <span className={valueClass}>{value}</span>
      {after}
    </p>
  );
}
