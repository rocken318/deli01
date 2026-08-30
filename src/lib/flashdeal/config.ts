import "server-only";
import type { Sql, TransactionSql } from "postgres";
import type { FlashDealConfig } from "@/domain/flashdeal";

/**
 * 直前割の CMS 設定（spec L652。正は site_settings.flash_deal_config / 0017）。
 *
 * ★既定は enabled=false: 割引は金銭に直結するため、発注者が CMS で
 * 率・時間帯・1日上限・対象コースを確認してから有効化する
 * （cancellation_policy / point_policy と同じ「雛形」の整理 / 判断ログ #24(d) 同様）。
 */
export const DEFAULT_FLASH_DEAL_CONFIG: FlashDealConfig = {
  enabled: false,
  ratePercent: 10,
  windowFromHour: 18,
  windowToHour: 24,
  dailyLimit: 3,
  courseIds: [],
  triggerHour: 15,
};

function intInRange(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
    ? v
    : null;
}

/**
 * site_settings.flash_deal_config の読み取り。
 * 壊れた値は項目単位で既定（雛形）へ倒す。enabled は明示 true のときだけ有効
 * （金銭のため、設定破損時に勝手に割引が動かない方向へ倒す）。
 */
export async function loadFlashDealConfig(
  sql: Sql | TransactionSql,
): Promise<FlashDealConfig> {
  const rows = await sql<{ value: unknown }[]>`
    select value from site_settings where key = 'flash_deal_config' limit 1
  `;
  const raw = rows[0]?.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_FLASH_DEAL_CONFIG;
  }
  const o = raw as {
    enabled?: unknown;
    rate_percent?: unknown;
    window_from_hour?: unknown;
    window_to_hour?: unknown;
    daily_limit?: unknown;
    course_ids?: unknown;
    trigger_hour?: unknown;
  };
  const courseIds = Array.isArray(o.course_ids)
    ? o.course_ids.filter((v): v is string => typeof v === "string")
    : DEFAULT_FLASH_DEAL_CONFIG.courseIds;
  return {
    enabled: o.enabled === true,
    ratePercent:
      intInRange(o.rate_percent, 1, 100) ?? DEFAULT_FLASH_DEAL_CONFIG.ratePercent,
    windowFromHour:
      intInRange(o.window_from_hour, 0, 23) ??
      DEFAULT_FLASH_DEAL_CONFIG.windowFromHour,
    windowToHour:
      intInRange(o.window_to_hour, 1, 24) ?? DEFAULT_FLASH_DEAL_CONFIG.windowToHour,
    dailyLimit:
      intInRange(o.daily_limit, 0, 1000) ?? DEFAULT_FLASH_DEAL_CONFIG.dailyLimit,
    courseIds,
    triggerHour:
      intInRange(o.trigger_hour, 0, 23) ?? DEFAULT_FLASH_DEAL_CONFIG.triggerHour,
  };
}
