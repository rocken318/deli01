/**
 * 当日オプション追加（延長）の可否判定（フェーズ15 / spec 3-4 L289・受入 L1100）。
 *
 * この業態の最大の運用リスク＝施術中の延長で次の予約に間に合わなくなること。
 * 「押した瞬間に後続予約への影響を判定して可否を返す」を DB 非依存の純粋関数にする。
 *
 * 占有モデル（docs/booking-holds.md §1・§4）:
 * - 占有区間は depart_at〜free_at。追加オプションで L（施術＋オプション時間）が
 *   addedMinutes 増えると end_at と free_at が同じだけ後ろへ伸びる（depart_at は不変）。
 * - 同一セラピストの後続予約の depart_at を **newFreeAt が超えると重複**（exclusion 制約
 *   no_therapist_overlap が最終的に弾く）。半開区間 '[)' なので newFreeAt == nextDepartAt
 *   は隣接＝重複でない（詰めきりOK）。
 */

export interface ExtensionCheck {
  /** 追加してよいか（後続に間に合うか） */
  ok: boolean;
  /** 延長後の free_at（占有上端） */
  newFreeAt: Date;
  /** ok=false のとき、後続 depart_at を何分超過するか（分・切り上げ） */
  shortfallMin?: number;
}

/**
 * 当日延長の可否を判定する。
 * @param currentFreeAt 現在の free_at（占有上端）
 * @param addedMinutes  追加オプションで増える施術時間（分・正の整数）
 * @param nextDepartAt  同一セラピストの直近後続予約の depart_at（無ければ null）
 */
export function canExtend(params: {
  currentFreeAt: Date;
  addedMinutes: number;
  nextDepartAt: Date | null;
}): ExtensionCheck {
  const { currentFreeAt, addedMinutes, nextDepartAt } = params;
  if (!Number.isInteger(addedMinutes) || addedMinutes < 0) {
    throw new RangeError(`addedMinutes は 0 以上の整数であること: ${addedMinutes}`);
  }

  const newFreeAt = new Date(currentFreeAt.getTime() + addedMinutes * 60_000);

  // 後続なしなら常に可
  if (nextDepartAt === null) {
    return { ok: true, newFreeAt };
  }

  // '[)' 半開区間: newFreeAt == nextDepartAt は隣接（重複でない）＝可
  if (newFreeAt.getTime() <= nextDepartAt.getTime()) {
    return { ok: true, newFreeAt };
  }

  const shortfallMin = Math.ceil(
    (newFreeAt.getTime() - nextDepartAt.getTime()) / 60_000,
  );
  return { ok: false, newFreeAt, shortfallMin };
}
