import { assertInt, sumLedger } from "../points/ledger";
import { resolveRate } from "./resolve";
import type {
  BusinessDate,
  PayoutCalcNote,
  PayoutLineDraft,
  PayoutRate,
  PayoutSettings,
  PayoutTargetType,
  ResolvedRate,
} from "./types";
import { DEFAULT_PAYOUT_SETTINGS } from "./types";

/**
 * 報酬計算の純粋関数（フェーズ18 / spec 11章）。DB にも Next.js にも依存しない。
 *
 * - 金額は整数（円）のみ。率は整数%。floor で切り捨て。小数は RangeError
 * - calc_note に「使ったレート・元金額・計算式・レートID・適用日」を必ず残す
 *   （spec L913・受入 L1098）。レート改定後も台帳のこのスナップショットは不変（L1094）
 * - 回数券消化でもバックは発生する（spec L917・受入 L1095）。
 *   現金の有無で分岐しない。抑止できるのは設定（includeTicketRedeemInBase=false）のみ
 * - noshow は既定で交通費のみ支給（spec L919）
 * - 値引時の基礎は設定（discountBase）。既定は「値引前」（spec L920）
 */

// ---------------------------------------------------------------------------
// 1. 1行の計算（computePayoutLine）
// ---------------------------------------------------------------------------

export interface ComputePayoutLineInput {
  /** resolveRate の結果 */
  rate: ResolvedRate;
  /** 元金額（円・整数・0以上）。fixed レートでも記録のため必須 */
  baseAmount: number;
  /** 施術の営業日（calc_note に残す） */
  businessDate?: BusinessDate;
  /** 表示用ラベル（例: '90分コース'） */
  label?: string;
}

/**
 * 1レート×1基礎額 → 報酬額と計算根拠。
 * - fixed: 円そのまま（基礎額に依存しない。指名料全額バック等）
 * - rate : floor(baseAmount × value / 100)
 */
export function computePayoutLine(input: ComputePayoutLineInput): {
  amount: number;
  calcNote: PayoutCalcNote;
} {
  const { rate, scope } = input.rate;
  assertInt("baseAmount", input.baseAmount);
  if (input.baseAmount < 0) {
    throw new RangeError(`baseAmount は 0 以上であること: ${input.baseAmount}`);
  }
  assertInt("rate.value", rate.value);

  let amount: number;
  let formula: string;
  if (rate.calcType === "fixed") {
    amount = rate.value;
    formula = `固定 ${rate.value}円`;
  } else {
    if (rate.value < 0 || rate.value > 100) {
      throw new RangeError(`率は 0〜100 の整数%であること: ${rate.value}`);
    }
    amount = Math.floor((input.baseAmount * rate.value) / 100);
    formula = `${input.baseAmount}円 × ${rate.value}% = ${amount}円`;
  }
  assertInt("amount", amount);

  const calcNote: PayoutCalcNote = {
    rateId: rate.id,
    scope,
    targetType: rate.targetType,
    targetId: rate.targetId,
    calcType: rate.calcType,
    rateValue: rate.value,
    effectiveFrom: rate.effectiveFrom,
    baseAmount: input.baseAmount,
    amount,
    formula,
    businessDate: input.businessDate ?? null,
    ...(input.label !== undefined ? { label: input.label } : {}),
  };
  return { amount, calcNote };
}

// ---------------------------------------------------------------------------
// 2. 1予約 → payout_lines ドラフト配列（buildReservationPayout）
// ---------------------------------------------------------------------------

/** 予約の結果。cancelled はキャンセル料が発生した場合のみ渡す */
export type ReservationOutcome = "done" | "noshow" | "cancelled";

export interface ReservationPayoutInput {
  therapistId: string;
  /** セラピストのランク。null = ランクなし */
  rankId: string | null;
  /** 施術の営業日（Asia/Tokyo の start_at の日付） */
  businessDate: BusinessDate;
  outcome: ReservationOutcome;
  courseId: string;
  /** コース定価（円・値引前）。予約時点のスナップショットから */
  coursePrice: number;
  courseLabel?: string;
  /** 予約に付いたオプション（price は price_snapshot） */
  options: ReadonlyArray<{ optionId: string; price: number; label?: string }>;
  /** 指名料（reservations.nomination_fee のスナップショット） */
  nominationFee: number;
  /** 交通費（reservations.transport_fee のスナップショット） */
  transportFee: number;
  /** 深夜加算（円）。24:00〜5:00 開始で発生（spec 18-3） */
  lateNightFee: number;
  /** 値引合計（正の円）。直前割等。既定 0 */
  discountAmount?: number;
  /** ポイント利用（正の数）。既定 0 */
  pointsUsed?: number;
  /** 回数券消化の施術か。★バック発生の有無は変わらない（spec L917） */
  paidByTicket?: boolean;
  /** outcome='cancelled' のときのキャンセル料（円）。バック配分は cancel_fee レート */
  cancelFeeAmount?: number;
}

export interface ReservationPayoutResult {
  lines: PayoutLineDraft[];
  /** 基礎額 > 0 なのにレートが解決できなかった対象（呼び出し側で警告する） */
  unresolved: Array<{
    targetType: PayoutTargetType;
    targetId: string | null;
    baseAmount: number;
  }>;
}

/**
 * 1予約の報酬内訳を組み立てる（spec 11-2。カテゴリごとに独立行・合算しない）。
 *
 * - done: course / option（1件1行）/ nomination / transport / late_night
 * - noshow: **交通費のみ**（spec L919 既定。移動だけ発生したケース）
 * - cancelled: cancel_fee（キャンセル料 × cancel_fee レート / spec L918）
 *   + 移動が発生していれば transport（transportFee > 0 のとき）
 * - 回数券消化でも course のバックは立つ（L917・受入 L1095）。
 *   includeTicketRedeemInBase=false の設定時のみ基礎 0 で行なし
 * - 値引の基礎は discountBase（既定 'before' = 値引前 / L920）。
 *   値引・ポイントの控除は course の基礎からのみ行う（オプション等には及ぼさない）
 * - 0 円になった行は立てない（台帳に 0 行を積まない）
 */
export function buildReservationPayout(input: {
  reservation: ReservationPayoutInput;
  rates: ReadonlyArray<PayoutRate>;
  settings?: PayoutSettings;
}): ReservationPayoutResult {
  const r = input.reservation;
  const settings = input.settings ?? DEFAULT_PAYOUT_SETTINGS;

  assertNonNegative("coursePrice", r.coursePrice);
  assertNonNegative("nominationFee", r.nominationFee);
  assertNonNegative("transportFee", r.transportFee);
  assertNonNegative("lateNightFee", r.lateNightFee);
  const discountAmount = r.discountAmount ?? 0;
  const pointsUsed = r.pointsUsed ?? 0;
  const cancelFeeAmount = r.cancelFeeAmount ?? 0;
  assertNonNegative("discountAmount", discountAmount);
  assertNonNegative("pointsUsed", pointsUsed);
  assertNonNegative("cancelFeeAmount", cancelFeeAmount);
  for (const opt of r.options) assertNonNegative("option.price", opt.price);

  const lines: PayoutLineDraft[] = [];
  const unresolved: ReservationPayoutResult["unresolved"] = [];

  const push = (
    targetType: PayoutTargetType,
    targetId: string | null,
    baseAmount: number,
    label?: string,
    optionId?: string,
    baseDetail?: PayoutCalcNote["base"],
  ): void => {
    if (baseAmount <= 0 && targetTypeNeedsBase(targetType)) return;
    const resolved = resolveRate({
      rates: input.rates,
      therapistId: r.therapistId,
      rankId: r.rankId,
      targetType,
      targetId,
      businessDate: r.businessDate,
    });
    if (resolved === null) {
      if (baseAmount > 0) unresolved.push({ targetType, targetId, baseAmount });
      return;
    }
    const { amount, calcNote } = computePayoutLine({
      rate: resolved,
      baseAmount,
      businessDate: r.businessDate,
      ...(label !== undefined ? { label } : {}),
    });
    if (amount === 0) return; // 0 円行は立てない
    if (baseDetail !== undefined) calcNote.base = baseDetail;
    lines.push({
      category: targetType,
      ...(optionId !== undefined ? { optionId } : {}),
      amount,
      calcNote,
    });
  };

  // ★交通費はセラピストのバックに一切入れない（発注者決定 2026-09-04）。
  //   交通費は店がドライバーへ支払う経費＝本人の取り分ではない。よって done/noshow/
  //   cancelled いずれでも transport の payout 行は立てない（旧: 交通費のみ支給）。
  if (r.outcome === "noshow") {
    // 交通費は本人に入れないため、noshow は payout なし（移動費は店の経費で別管理）。
    return { lines, unresolved };
  }

  if (r.outcome === "cancelled") {
    // キャンセル料のバック配分（spec L918。配分率は cancel_fee レートの設定）
    push("cancel_fee", null, cancelFeeAmount);
    return { lines, unresolved };
  }

  // outcome === 'done'
  // course の基礎額: 定価から設定に応じて控除（spec L917・L920・L848）
  let courseBase = r.coursePrice;
  if (r.paidByTicket === true && !settings.includeTicketRedeemInBase) {
    courseBase = 0;
  } else {
    if (settings.discountBase === "after") courseBase -= discountAmount;
    if (!settings.includePointUseInBase) courseBase -= pointsUsed;
    if (courseBase < 0) courseBase = 0;
  }
  push("course", r.courseId, courseBase, r.courseLabel, undefined, {
    listPrice: r.coursePrice,
    discountAmount,
    pointsUsed,
    discountBase: settings.discountBase,
    includePointUseInBase: settings.includePointUseInBase,
    paidByTicket: r.paidByTicket === true,
  });

  for (const opt of r.options) {
    push("option", opt.optionId, opt.price, opt.label, opt.optionId);
  }
  push("nomination", null, r.nominationFee);
  // transport は立てない（上記の発注者決定。店の経費として扱う）
  push("late_night", null, r.lateNightFee);

  return { lines, unresolved };
}

/** fixed レートは基礎 0 でも意味を持ち得るが、基礎必須の種別は基礎 0 なら行なし */
function targetTypeNeedsBase(targetType: PayoutTargetType): boolean {
  // すべての種別で「対象の料金が 0（発生していない）なら報酬も発生しない」を採る。
  // 例: 指名なし（nominationFee=0）で fixed レートがあっても指名バックは立てない
  void targetType;
  return true;
}

// ---------------------------------------------------------------------------
// 3. 締め集計（settlePayoutPeriod）
// ---------------------------------------------------------------------------

export interface PayoutPeriodSettlement {
  /** 期間内 payout_lines の総和（逆仕訳込みの純額） */
  gross: number;
  /** 控除合計（立替・備品・貸付・源泉手入力） */
  deductions: number;
  /** 支払額 = gross − deductions */
  net: number;
  lineCount: number;
}

/**
 * 締めの集計（spec 11-4）。gross = Σ lines.amount（逆仕訳込み）、
 * net = gross − Σ deductions。すべて整数円。
 */
export function settlePayoutPeriod(input: {
  lines: ReadonlyArray<{ amount: number }>;
  deductions?: ReadonlyArray<{ amount: number }>;
}): PayoutPeriodSettlement {
  const gross = sumLedger(input.lines.map((l) => l.amount));
  const deductionList = input.deductions ?? [];
  for (const d of deductionList) {
    assertInt("deduction.amount", d.amount);
    if (d.amount <= 0) {
      throw new RangeError(`控除は正の円であること: ${d.amount}`);
    }
  }
  const deductions = sumLedger(deductionList.map((d) => d.amount));
  const net = gross - deductions;
  assertInt("net", net);
  return { gross, deductions, net, lineCount: input.lines.length };
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
