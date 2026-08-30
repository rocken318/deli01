import "server-only";
import type { Sql } from "postgres";

/**
 * ポイント付与・利用ポリシー（spec L838-841。CMS = site_settings.point_policy が正）。
 *
 * 既定値は**雛形**であり、金銭に関わる実値（率・失効日数・利用上限/下限）は
 * 発注者が CMS で設定してから運用する前提（cancellation_policy と同じ整理 /
 * 判断ログ#24(d)）。コース別率・ランク別率・各種ボーナスは v1 では未実装で、
 * 拡張時もこの型に足して earn 行を分けて追記する（src/domain/points/earn.ts 参照）。
 */
export interface PointPolicy {
  /** 付与率（整数%）。付与P = floor(支払額 × rate / 100) */
  earnRatePercent: number;
  /** 付与から失効までの日数。null = 無期限 */
  expiryDays: number | null;
  /** 1回の利用下限（P）。null = 制限なし */
  minUse: number | null;
  /** 1回の利用上限（P）。null = 制限なし */
  maxUse: number | null;
}

/** 雛形（CMS 未設定時のフォールバック。実値は発注者が CMS で設定する） */
export const DEFAULT_POINT_POLICY: PointPolicy = {
  earnRatePercent: 5,
  expiryDays: 365,
  minUse: null,
  maxUse: null,
};

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** site_settings.point_policy の読み取り（壊れていれば雛形） */
export async function loadPointPolicy(sql: Sql): Promise<PointPolicy> {
  const rows = await sql<{ value: unknown }[]>`
    select value from site_settings where key = 'point_policy' limit 1
  `;
  const raw = rows[0]?.value;
  if (!raw || typeof raw !== "object") return DEFAULT_POINT_POLICY;
  const o = raw as {
    earn_rate_percent?: unknown;
    expiry_days?: unknown;
    min_use?: unknown;
    max_use?: unknown;
  };
  const rate = intOrNull(o.earn_rate_percent);
  return {
    earnRatePercent:
      rate !== null && rate <= 100 ? rate : DEFAULT_POINT_POLICY.earnRatePercent,
    // 失効日数は設定漏れ時に **無期限にしない**（金銭・引当が無限に積まれる / reviewer S5）。
    // 未設定・不正値は雛形（365日）へ倒す。min/max は未設定=制限なしが妥当なので null 可。
    expiryDays: intOrNull(o.expiry_days) ?? DEFAULT_POINT_POLICY.expiryDays,
    minUse: intOrNull(o.min_use),
    maxUse: intOrNull(o.max_use),
  };
}
