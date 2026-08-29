/**
 * コース・オプションの施術時間と金額の純粋関数（フェーズ7 / spec 3-4・5-3）。
 *
 * DB にも Next.js にも依存しない。courses / options（予約確定後は
 * reservation_options のスナップショット値）を呼び出し側が数値で渡す。
 *
 * spec 3-4 / 5-3:
 * - **duration_min が空き枠計算に効く。** 空き枠アルゴリズムの施術時間 L は
 *   コース時間ではなく「コース + 選択オプションの duration_min 合計」。
 *   +30分のオプションを付けたら、その分だけ次の予約との間隔が要る。
 * - 金額はすべて**整数（円）**。小数は RangeError（CLAUDE.md 禁止事項）。
 *
 * フェーズ9（空き枠エンジン）が totalServiceMinutes を L として使い、
 * フェーズ11（注文画面・予約確定）が totalPrice を合計金額の算出に使う。
 * 予約確定時には価格・時間・バックを reservation_options にスナップショットする
 * （spec 3-4: 後からオプションの値を変えても過去の予約は変わらない）。
 */

/** 選択オプションのうち施術時間の計算に必要な列（options.duration_min の写像） */
export interface OptionDurationLike {
  /** 施術時間への加算（分・整数。0 も可） */
  durationMin: number;
}

/** 選択オプションのうち金額の計算に必要な列（options.price の写像） */
export interface OptionPriceLike {
  /** 価格（円・整数） */
  price: number;
}

function assertIntMin(value: number, label: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${label} は ${min} 以上の整数であること: ${value}`);
  }
}

/**
 * 施術時間 L（分・整数） = コース時間 + 選択オプションの duration_min 合計（spec 5-3）。
 * 空き枠アルゴリズムの `s + buffer_before + L + buffer_after + travel(A→N) ≤ t_n` の L。
 */
export function totalServiceMinutes(
  courseDurationMin: number,
  selectedOptions: readonly OptionDurationLike[],
): number {
  assertIntMin(courseDurationMin, "courseDurationMin", 1);
  let total = courseDurationMin;
  for (const opt of selectedOptions) {
    assertIntMin(opt.durationMin, "option.durationMin", 0);
    total += opt.durationMin;
  }
  return total;
}

/**
 * 合計金額（円・整数） = コース価格 + 選択オプション価格合計 + 指名料 + 交通費。
 * すべて整数（円）。小数・負数は RangeError。
 * 深夜加算・割引などの追加行はフェーズ11以降で revenue_lines 側に積む。
 */
export function totalPrice(input: {
  coursePrice: number;
  selectedOptions: readonly OptionPriceLike[];
  /** 指名料（フリーなら 0 / spec 18-3） */
  nominationFee?: number;
  /** 交通費（徒歩圏なら 0 / spec 18-3） */
  transportFee?: number;
}): number {
  assertIntMin(input.coursePrice, "coursePrice", 0);
  const nomination = input.nominationFee ?? 0;
  const transport = input.transportFee ?? 0;
  assertIntMin(nomination, "nominationFee", 0);
  assertIntMin(transport, "transportFee", 0);
  let total = input.coursePrice + nomination + transport;
  for (const opt of input.selectedOptions) {
    assertIntMin(opt.price, "option.price", 0);
    total += opt.price;
  }
  return total;
}
