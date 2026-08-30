/**
 * 追記専用台帳の共通最小関数（spec 9・10・11章）。
 *
 * ポイント（point_entries）で最初に固め、フェーズ17（revenue_lines）・
 * 18（payout_lines）が同じ型・同じ規約で再利用する:
 *   - 残高/合計はカラムで持たず、常に符号付き整数の総和
 *   - 修正は上書きせず逆仕訳（reverse）で打ち消す
 *   - 金額・ポイントはすべて整数。小数は RangeError
 */

/** value が安全な整数でなければ RangeError（金額・ポイントの共通ガード） */
export function assertInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} は整数であること: ${value}`);
  }
}

/** 符号付き整数列の総和（台帳の残高計算の核。空なら 0） */
export function sumLedger(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) {
    assertInt("values[]", v);
    total += v;
  }
  assertInt("sum", total);
  return total;
}

/** ポイント台帳の残高 = sum(points)（spec L836。正は台帳） */
export function balance(entries: ReadonlyArray<{ points: number }>): number {
  return sumLedger(entries.map((e) => e.points));
}
