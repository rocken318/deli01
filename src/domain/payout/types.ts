/**
 * 報酬（業務委託バック）の型（フェーズ18 / spec 11章 L873-949）。
 *
 * DB にも Next.js にも依存しない。金額はすべて整数（円）、率は整数%。
 * 日付は Asia/Tokyo の 'YYYY-MM-DD' 文字列（辞書順 = 時間順）で扱い、
 * Date の時刻計算はしない（business_date は日付そのものが意味を持つため）。
 */

/** payout_rates.target_type / payout_lines.category（adjustment を除く）の写像 */
export type PayoutTargetType =
  | "course"
  | "option"
  | "nomination"
  | "transport"
  | "late_night"
  | "cancel_fee";

/** payout_lines.category の写像（target 種別 + 手動調整） */
export type PayoutCategory = PayoutTargetType | "adjustment";

/** fixed = 円（整数） / rate = 率（整数%） */
export type PayoutCalcType = "fixed" | "rate";

/** レートのスコープ。優先順位は individual > rank > default（spec L894） */
export type PayoutRateScope = "individual" | "rank" | "default";

/** 'YYYY-MM-DD'（Asia/Tokyo）の営業日 */
export type BusinessDate = string;

/** payout_rates の1行（DB 非依存の写像） */
export interface PayoutRate {
  id: string;
  /** 個別レート。null 以外なら本人にのみ適用 */
  therapistId: string | null;
  /** ランク別レート。null 以外なら該当ランクにのみ適用 */
  rankId: string | null;
  targetType: PayoutTargetType;
  /** コースID・オプションID など。null = その種別の全対象（generic） */
  targetId: string | null;
  calcType: PayoutCalcType;
  /** fixed: 円（整数・0以上） / rate: 整数%（0〜100） */
  value: number;
  /** 適用開始日（この日を含む）。'YYYY-MM-DD' */
  effectiveFrom: BusinessDate;
  /** 適用終了日（この日を含まない = 半開区間）。null = 無期限 */
  effectiveTo: BusinessDate | null;
}

/** resolveRate の結果。どのスコープで解決されたかを持つ（calc_note に残す） */
export interface ResolvedRate {
  rate: PayoutRate;
  scope: PayoutRateScope;
}

/**
 * ★計算根拠のスナップショット（spec L913・受入 L1098）。
 * payout_lines.calc_note にそのまま jsonb で保存する。
 * 「90分コース 12,000円 × 45% = 5,400円、レートID xxx、適用日 2026-04-01」が
 * この1オブジェクトから復元できること。レート改定後もここは変わらない（L1094）。
 */
export interface PayoutCalcNote {
  /** 使ったレートの ID（payout_rates.id）。adjustment / 逆仕訳では null */
  rateId: string | null;
  /** individual / rank / default のどれで解決されたか */
  scope: PayoutRateScope | null;
  targetType: PayoutTargetType | null;
  targetId: string | null;
  calcType: PayoutCalcType | null;
  /** レート値（fixed: 円 / rate: %） */
  rateValue: number | null;
  /** レートの適用開始日（スナップショット） */
  effectiveFrom: BusinessDate | null;
  /** 元金額（円）。バック計算の基礎 */
  baseAmount: number;
  /** 確定した報酬額（円） */
  amount: number;
  /** 人が読める計算式（例: '12000円 × 45% = 5400円'） */
  formula: string;
  /** 計算対象の営業日 */
  businessDate: BusinessDate | null;
  /** 表示用ラベル（例: '90分コース'）。任意 */
  label?: string;
  /** course 行のみ: 基礎額の決定過程（値引・ポイント・回数券の扱い） */
  base?: {
    listPrice: number;
    discountAmount: number;
    pointsUsed: number;
    discountBase: "before" | "after";
    includePointUseInBase: boolean;
    paidByTicket: boolean;
  };
}

/** insert 前の payout_lines 行（DB 非依存） */
export interface PayoutLineDraft {
  category: PayoutCategory;
  /** option 行のみ */
  optionId?: string;
  /** 円・整数・正（逆仕訳と adjustment 以外） */
  amount: number;
  calcNote: PayoutCalcNote;
}

/**
 * バック基礎の設定（spec L848・L917・L920）。
 * site_settings.payout_policy（0015/0016）の写像。すべて既定値あり。
 */
export interface PayoutSettings {
  /** 値引時のバック基礎。既定 'before' = 値引前（spec L920。事業判断） */
  discountBase: "before" | "after";
  /** ポイント利用分を基礎に含める。既定 true（spec L848） */
  includePointUseInBase: boolean;
  /** 回数券消化の施術も基礎に含める。既定 true（spec L917: 消化でもバック発生） */
  includeTicketRedeemInBase: boolean;
}

export const DEFAULT_PAYOUT_SETTINGS: PayoutSettings = {
  discountBase: "before",
  includePointUseInBase: true,
  includeTicketRedeemInBase: true,
};
