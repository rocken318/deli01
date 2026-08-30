import "server-only";
import type { Sql } from "postgres";

/**
 * バック計算基礎の設定（spec L848・L917・L920。CMS = site_settings.payout_policy が正）。
 *
 * - ポイント利用分（point_use のマイナス行）をセラピストのバック計算基礎に
 *   含めるか。**既定は「含める」**（施術内容は同じなので / spec L848）
 * - 回数券消化（ticket_redeem = 前受金の振替）も同じ論点（spec L848・L917:
 *   「回数券を消化した施術でもバックは発生する」）。既定は「含める」
 *
 * フェーズ17 ではフラグの置き場所と読み手だけを用意する。
 * 実際にこれを使って基礎額を決めるのはフェーズ18（報酬計算）。
 */
export interface PayoutPolicy {
  /** ポイント利用分をバック計算基礎に含める（値引前を基礎にする） */
  includePointUseInBase: boolean;
  /** 回数券消化の施術もバック計算基礎に含める（定価ベースで基礎を立てる） */
  includeTicketRedeemInBase: boolean;
}

/** 既定は両方「含める」（spec L848） */
export const DEFAULT_PAYOUT_POLICY: PayoutPolicy = {
  includePointUseInBase: true,
  includeTicketRedeemInBase: true,
};

/** site_settings.payout_policy の読み取り（壊れていれば既定 = 含める） */
export async function loadPayoutPolicy(sql: Sql): Promise<PayoutPolicy> {
  const rows = await sql<{ value: unknown }[]>`
    select value from site_settings where key = 'payout_policy' limit 1
  `;
  const raw = rows[0]?.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_PAYOUT_POLICY;
  }
  const o = raw as {
    include_point_use_in_base?: unknown;
    include_ticket_redeem_in_base?: unknown;
  };
  return {
    includePointUseInBase:
      typeof o.include_point_use_in_base === "boolean"
        ? o.include_point_use_in_base
        : DEFAULT_PAYOUT_POLICY.includePointUseInBase,
    includeTicketRedeemInBase:
      typeof o.include_ticket_redeem_in_base === "boolean"
        ? o.include_ticket_redeem_in_base
        : DEFAULT_PAYOUT_POLICY.includeTicketRedeemInBase,
  };
}
