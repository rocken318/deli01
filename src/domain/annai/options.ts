/**
 * オプションのセラピスト対応絞り込み（判断#37 / spec 3-4）。
 * option_availability に行があるオプションは「対応セラピストのみ」表示。
 * 行が無いオプションは全員対応。案内表の行（=セラピスト）ごとに押せる OP を絞る純関数
 * （非対応 OP は engine/loadOptionSnapshots で黙って落ちて総額がズレるため UI から出さない）。
 */

export interface OptionAvailabilityRow {
  option_id: string;
  therapist_id: string;
}

/** availability 行から「制限付きオプション集合」と「option→対応セラピスト集合」を作る。 */
export function indexOptionAvailability(rows: OptionAvailabilityRow[]): {
  restricted: Set<string>;
  supportBy: Map<string, Set<string>>;
} {
  const restricted = new Set<string>();
  const supportBy = new Map<string, Set<string>>();
  for (const a of rows) {
    restricted.add(a.option_id);
    let s = supportBy.get(a.option_id);
    if (!s) supportBy.set(a.option_id, (s = new Set()));
    s.add(a.therapist_id);
  }
  return { restricted, supportBy };
}

/** 指定セラピストが押せるオプションだけに絞る（id を持つ任意のオプション型で動く）。 */
export function filterOptionsForTherapist<T extends { id: string }>(
  options: T[],
  therapistId: string,
  index: { restricted: Set<string>; supportBy: Map<string, Set<string>> },
): T[] {
  return options.filter(
    (o) => !index.restricted.has(o.id) || (index.supportBy.get(o.id)?.has(therapistId) ?? false),
  );
}
