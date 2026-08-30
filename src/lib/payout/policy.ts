import "server-only";
import type { Sql } from "postgres";
import type { PayoutSettings } from "@/domain/payout";
import { DEFAULT_PAYOUT_SETTINGS } from "@/domain/payout";

/**
 * バック計算基礎の設定の読み取り（spec L848・L917・L920）。
 * 正は site_settings.payout_policy（0015 で導入・0016 で discount_base を追加）。
 * lib/accounting/policy.ts の PayoutPolicy と同じ行を読むが、
 * フェーズ18 は discount_base を含む PayoutSettings（domain/payout）へ写す。
 * 壊れていれば既定（値引前・すべて基礎に含める）。
 */
export async function loadPayoutSettings(sql: Sql): Promise<PayoutSettings> {
  const rows = await sql<{ value: unknown }[]>`
    select value from site_settings where key = 'payout_policy' limit 1
  `;
  const raw = rows[0]?.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_PAYOUT_SETTINGS;
  }
  const o = raw as {
    include_point_use_in_base?: unknown;
    include_ticket_redeem_in_base?: unknown;
    discount_base?: unknown;
  };
  return {
    discountBase: o.discount_base === "after" ? "after" : "before",
    includePointUseInBase:
      typeof o.include_point_use_in_base === "boolean"
        ? o.include_point_use_in_base
        : DEFAULT_PAYOUT_SETTINGS.includePointUseInBase,
    includeTicketRedeemInBase:
      typeof o.include_ticket_redeem_in_base === "boolean"
        ? o.include_ticket_redeem_in_base
        : DEFAULT_PAYOUT_SETTINGS.includeTicketRedeemInBase,
  };
}
