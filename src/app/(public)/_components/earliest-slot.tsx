/**
 * 署名要素「最短 HH:MM から案内可能」（spec 12-1）。
 *
 * このサービスが顧客に約束しているのは結局その一点なので、デザインの主役に置く。
 * 大きく・金色・等幅。値（時刻）は空き枠エンジン（spec 5章 / フェーズ9）実装後に入る。
 * 本フェーズは値なし＝placeholder（CMS 由来の文言）を等幅で出すだけ。
 *
 * 文言はすべて content レイヤ経由（labels）。日本語リテラルを持たない。
 * - template: 「最短 {time} から案内可能」のような雛形（{time} を time で差し替え）
 * - templateFuture: 「最短 {date} {time} から案内可能」（当日以外。{date}{time} を差し替え）
 * - placeholder: 値未確定時に time の位置に出す文字（例: 「調整中」）
 * - dateISO: 枠の営業日（"YYYY-MM-DD"）。today と比較し当日でなければ日付を明記
 * - today: 比較用当日 ISO（"YYYY-MM-DD"）。省略時は表示側で当日扱い
 */

import { formatInTimeZone } from "date-fns-tz";
import { parseISO } from "date-fns";

const APP_TZ = "Asia/Tokyo";

/** 曜日インデックス配列（0=日〜6=土）。文字列は ui_labels の weekdays キー（カンマ区切り）から解決 */
function weekdayChar(dateISO: string, weekdays: string): string {
  try {
    const d = parseISO(dateISO);
    const idx = Number(formatInTimeZone(d, APP_TZ, "e")) % 7; // date-fns "e" = 1=月〜7=日
    // "e" returns 1=Mon … 7=Sun → map to 0=Sun … 6=Sat
    const corrected = idx === 7 ? 0 : idx; // 7=Sun→0
    const days = weekdays.split(",");
    return days[corrected] ?? "";
  } catch {
    return "";
  }
}

/** dateISO を "M/d(曜)" 形式に整形（weekdays が空なら "M/d" のみ） */
function formatDateLabel(dateISO: string, weekdays: string): string {
  try {
    const d = parseISO(dateISO);
    const md = formatInTimeZone(d, APP_TZ, "M/d");
    const wd = weekdayChar(dateISO, weekdays);
    return wd ? `${md}(${wd})` : md;
  } catch {
    return dateISO;
  }
}

export function EarliestSlot({
  template,
  templateFuture,
  placeholder,
  weekdays = "",
  time,
  dateISO,
  today,
  size = "lg",
}: {
  /** 例: "最短 {time} から案内可能"（CMS labels.earliest_slot_template） */
  template: string;
  /** 当日以外のとき用テンプレート（CMS labels.earliest_slot_template_future）。
   *  {date} を M/d(曜) で、{time} を時刻で差し替える。空なら template を流用 */
  templateFuture?: string | null;
  /** 値未確定時に {time} へ差し込む文言（CMS labels.earliest_slot_pending） */
  placeholder: string;
  /** 曜日ラベル（ui_labels.schedule_weekdays / カンマ区切り "日,月,火,水,木,金,土"） */
  weekdays?: string;
  /** 確定時刻（Phase9 まで null） */
  time?: string | null;
  /** 枠の営業日 "YYYY-MM-DD"（非 null かつ today と異なれば日付を明記） */
  dateISO?: string | null;
  /** 比較用当日 ISO "YYYY-MM-DD"（省略時は dateISO が当日と見なす） */
  today?: string | null;
  size?: "lg" | "sm";
}) {
  // テンプレートが無い場合は描画しない（日本語のハードコード回避）
  if (!template) return null;

  // 当日かどうかを判定（dateISO が未設定 or today と一致すれば当日）
  const isFutureDate =
    dateISO && today && dateISO !== today;

  // 当日以外かつ templateFuture がある → {date}{time} を差し替え
  if (isFutureDate && templateFuture && time) {
    const dateLabel = formatDateLabel(dateISO, weekdays);
    const rendered = templateFuture
      .replace("{date}", dateLabel)
      .replace("{time}", time);

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
        <span className={valueClass}>{rendered}</span>
      </p>
    );
  }

  // 当日以外かつ templateFuture が無い場合: template + 日付プレフィックス
  const value = time ?? placeholder;
  const [before, after] = template.includes("{time}")
    ? template.split("{time}")
    : [template, ""];

  const valueClass =
    size === "lg"
      ? "font-mono text-2xl font-medium text-pub-primary"
      : "font-mono text-lg font-medium text-pub-primary";

  // 当日以外 + time あり + テンプレートに {time} 含む: 日付を前置
  const datePrefix = isFutureDate && time
    ? formatDateLabel(dateISO, weekdays) + " "
    : "";

  return (
    <p
      className={
        size === "lg"
          ? "text-sm text-pub-subtext"
          : "text-xs text-pub-subtext"
      }
    >
      {before}
      <span className={valueClass}>{datePrefix}{value}</span>
      {after}
    </p>
  );
}
