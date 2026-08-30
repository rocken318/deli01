import { assertInt, sumLedger } from "../points/ledger";

/**
 * 会計の純粋関数（フェーズ17 / spec 10章 L853-869・9章 L844-849・11-6）。
 *
 * DB にも Next.js にも依存しない。金額はすべて整数（円）。小数は RangeError。
 * 台帳の共通規約（追記専用・残高 = sum・逆仕訳）は src/domain/points/ledger.ts と同じ。
 *
 * 完了条件（受入 L1069）「前受金・ポイント引当・売上・経費が分けて出る」の核:
 *   - 売上         = revenueBreakdown が立てる revenue_lines の集計
 *   - 前受金       = deferredRevenue（回数券残 = sum(ticket_entries.amount)）
 *   - ポイント引当 = pointLiability（未消化ポイント = sum(point_entries.points)）
 *   - 経費         = expenses（入力データ）
 *   - 突合         = settlement（売上 − バック − 経費 = 粗利 / spec 11-6）
 */

// ---------------------------------------------------------------------------
// 1. 売上行の写像（spec L856: 独立行で計上・合算しない）
// ---------------------------------------------------------------------------

/** revenue_lines.line_type の写像 */
export type RevenueLineType =
  | "course"
  | "option"
  | "nomination"
  | "transport"
  | "midnight"
  | "discount"
  | "point_use"
  | "ticket_redeem";

/** insert 前の売上行（DB 非依存）。option 行は optionId を持つ */
export interface RevenueLineDraft {
  lineType: RevenueLineType;
  /** 円・整数。売上行は正、point_use は負 */
  amount: number;
  /** option 行のみ（(予約, option) 単位の二重計上防止キー） */
  optionId?: string;
}

/**
 * 料金内訳を revenue_lines の行配列に写す（spec L856）。
 *
 * - course/option/nomination/transport/midnight を**独立行**にする。合算しない
 * - オプションは1オプション1行（optionId 付き）
 * - 0円の構成要素は行にしない（台帳に 0 行を積まない / DB の nonzero check と対）
 * - 回数券消化の予約は course 行の**代わりに** ticket_redeem 行（前受金の配分額の
 *   振替 / spec L857・L917）。現金売上と混同しない。両方は立てない
 *   （DB の revenue_lines_core_uniq が物理的にも止める）
 * - ポイント利用は**マイナスの point_use 行**（spec L847。付与は行にしない / L846）
 */
export function revenueBreakdown(input: {
  /** コース料金（円）。ticketRedeemAmount 指定時は無視される（振替に置換） */
  coursePrice: number;
  /** オプション（1件1行）。price は円 */
  options: ReadonlyArray<{ optionId: string; price: number }>;
  nominationFee: number;
  transportFee: number;
  midnightSurcharge: number;
  /** 回数券消化: 前受金からの振替額（端数配分後の円）。null/未指定 = 現金系 */
  ticketRedeemAmount?: number | null;
  /** ポイント利用（正の数で渡す）。行は −pointsUsed で立つ。0/未指定 = なし */
  pointsUsed?: number;
}): RevenueLineDraft[] {
  assertNonNegative("coursePrice", input.coursePrice);
  assertNonNegative("nominationFee", input.nominationFee);
  assertNonNegative("transportFee", input.transportFee);
  assertNonNegative("midnightSurcharge", input.midnightSurcharge);
  if (input.ticketRedeemAmount != null) {
    assertNonNegative("ticketRedeemAmount", input.ticketRedeemAmount);
  }
  if (input.pointsUsed != null) {
    assertNonNegative("pointsUsed", input.pointsUsed);
  }

  const lines: RevenueLineDraft[] = [];

  // 施術本体: course か ticket_redeem のどちらか一方（両立は二重計上）
  if (input.ticketRedeemAmount != null) {
    if (input.ticketRedeemAmount > 0) {
      lines.push({ lineType: "ticket_redeem", amount: input.ticketRedeemAmount });
    }
  } else if (input.coursePrice > 0) {
    lines.push({ lineType: "course", amount: input.coursePrice });
  }

  for (const opt of input.options) {
    assertNonNegative("option.price", opt.price);
    if (opt.price > 0) {
      lines.push({ lineType: "option", amount: opt.price, optionId: opt.optionId });
    }
  }
  if (input.nominationFee > 0) {
    lines.push({ lineType: "nomination", amount: input.nominationFee });
  }
  if (input.transportFee > 0) {
    lines.push({ lineType: "transport", amount: input.transportFee });
  }
  if (input.midnightSurcharge > 0) {
    lines.push({ lineType: "midnight", amount: input.midnightSurcharge });
  }
  if (input.pointsUsed != null && input.pointsUsed > 0) {
    lines.push({ lineType: "point_use", amount: -input.pointsUsed });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 2. 回数券の端数配分（受入 L1092: 10,000円3回券 → 3,333 / 3,333 / 3,334）
// ---------------------------------------------------------------------------

/**
 * 券面総額を回数で配分する（累積 floor 差分方式）。
 * k回目（0始まり）の配分 = floor(total×(k+1)/count) − floor(total×k/count)。
 * 常に sum = totalAmount。端数は後ろの回に寄る（10,000/3 → 3,333/3,333/3,334）。
 */
export function ticketAllocation(input: {
  totalAmount: number;
  count: number;
}): number[] {
  assertInt("totalAmount", input.totalAmount);
  assertInt("count", input.count);
  if (input.totalAmount < 0 || input.count <= 0) {
    throw new RangeError(
      `回数券の配分が不正: total=${input.totalAmount}, count=${input.count}`,
    );
  }
  const result: number[] = [];
  let prev = 0;
  for (let k = 1; k <= input.count; k++) {
    const cum = Math.floor((input.totalAmount * k) / input.count);
    result.push(cum - prev);
    prev = cum;
  }
  return result;
}

/**
 * n回目の消化（redeemedSoFar 回消化済み）で前受金から売上へ振り替える額。
 * redeem 行の amount は −この値、ticket_redeem 行の amount は +この値。
 */
export function ticketRedeemAmount(input: {
  totalAmount: number;
  count: number;
  /** このロットで既に消化済みの回数（0 以上 count 未満） */
  redeemedSoFar: number;
}): number {
  assertInt("redeemedSoFar", input.redeemedSoFar);
  const alloc = ticketAllocation(input);
  if (input.redeemedSoFar < 0 || input.redeemedSoFar >= input.count) {
    throw new RangeError(
      `消化済み回数が範囲外: ${input.redeemedSoFar} / ${input.count}`,
    );
  }
  const amount = alloc[input.redeemedSoFar];
  if (amount === undefined) {
    throw new RangeError(`配分が解決できない: ${input.redeemedSoFar}`);
  }
  return amount;
}

// ---------------------------------------------------------------------------
// 3. 前受金・引当の集計（完了条件 L1069 の「分けて出る」の核）
// ---------------------------------------------------------------------------

/** ticket_entries の集計に必要な最小形 */
export interface TicketEntryLike {
  /** 回数の増減（purchase:+ / redeem・expire:−） */
  count: number;
  /** 前受金の増減（円） */
  amount: number;
}

/**
 * 回数券の前受金（負債）。残回数 = sum(count)、前受金残高 = sum(amount)。
 * 残高はカラムで持たない（spec L857。正は台帳）。
 */
export function deferredRevenue(entries: ReadonlyArray<TicketEntryLike>): {
  remainingCount: number;
  deferredAmount: number;
} {
  return {
    remainingCount: sumLedger(entries.map((e) => e.count)),
    deferredAmount: sumLedger(entries.map((e) => e.amount)),
  };
}

/** point_entries の集計に必要な最小形 */
export interface PointEntryLike {
  type: "earn" | "use" | "expire" | "adjust" | "reverse";
  points: number;
}

/** ポイント引当の内訳つき残高 */
export interface PointLiabilityBreakdown {
  /** 付与累計（正） */
  earned: number;
  /** 利用累計（正の大きさ） */
  used: number;
  /** 失効累計（正の大きさ。引当の戻入 / spec L849） */
  expired: number;
  /** 調整・逆仕訳の純額（符号つき） */
  adjusted: number;
  /** 引当残 = earned − used − expired + adjusted = sum(points)（1P = 1円） */
  liability: number;
}

/**
 * 未使用ポイント = 引当（負債）。付与は売上を減らさず引当として積み（spec L846）、
 * 失効は引当の戻入（L849）。すべて台帳（point_entries）から算出し、
 * revenue_lines には一切現れない（利用時の point_use 行だけが売上側に立つ / L847）。
 */
export function pointLiability(
  entries: ReadonlyArray<PointEntryLike>,
): PointLiabilityBreakdown {
  let earned = 0;
  let used = 0;
  let expired = 0;
  let adjusted = 0;
  for (const e of entries) {
    assertInt("points", e.points);
    switch (e.type) {
      case "earn":
        earned += e.points;
        break;
      case "use":
        used += -e.points; // use は負で記帳される → 正の大きさへ
        break;
      case "expire":
        expired += -e.points;
        break;
      case "adjust":
      case "reverse":
        adjusted += e.points;
        break;
    }
  }
  const liability = earned - used - expired + adjusted;
  assertInt("liability", liability);
  return { earned, used, expired, adjusted, liability };
}

// ---------------------------------------------------------------------------
// 4. 突合（spec 11-6: 売上 − バック − 経費 = 粗利）
// ---------------------------------------------------------------------------

/** 突合の結果。revenue_lines と payout_lines は独立に積み、ここで突き合わせる */
export interface Settlement {
  revenue: number;
  payout: number;
  expenses: number;
  /** 粗利 = 売上 − バック − 経費 */
  grossProfit: number;
}

/**
 * 突合の純計算（spec 11-6・受入 L1132）。
 * payout（バック）はフェーズ18 の payout_lines 集計。18 完了までは 0 を渡す
 * （骨組みだけ先に固定し、18 が値を差し込む）。
 */
export function settlement(input: {
  revenue: number;
  payout: number;
  expenses: number;
}): Settlement {
  assertInt("revenue", input.revenue);
  assertInt("payout", input.payout);
  assertInt("expenses", input.expenses);
  const grossProfit = input.revenue - input.payout - input.expenses;
  assertInt("grossProfit", grossProfit);
  return {
    revenue: input.revenue,
    payout: input.payout,
    expenses: input.expenses,
    grossProfit,
  };
}

// ---------------------------------------------------------------------------
// 内部ヘルパ
// ---------------------------------------------------------------------------

function assertNonNegative(name: string, value: number): void {
  assertInt(name, value);
  if (value < 0) {
    throw new RangeError(`${name} は 0 以上であること: ${value}`);
  }
}
