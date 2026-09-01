export interface JobItem {
  id: string;
  startAt: Date;
  endAt: Date;
  departAt: Date;
  freeAt: Date;
  totalAmount: number;
  status: string;
}
export type AttendanceState = "off" | "working" | "done";
export interface BoardInput {
  therapistId: string;
  slug: string;
  name: string;
  attendanceState: AttendanceState;
  shiftStart: Date | null;
  shiftEnd: Date | null;
  lateManual: boolean;
  done: JobItem[];
  upcoming: JobItem[];
}
export interface AvailWindow {
  kind: "now" | "from" | "off" | "done";
  fromMs: number | null; // null = 今すぐ（now 以下・working で空き）
  untilMs: number | null; // null = 上限なし
  gapMin: number | null;
  busyNow: boolean; // 現在 占有区間の中（接客中/移動中）
}
export interface BoardRow extends BoardInput {
  window: AvailWindow;
}

export const DEFAULT_BUFFERS = { afterBufferMin: 30, travelMin: 15 } as const;
const MIN = 60_000;

/**
 * 次案内可能ウィンドウを算出する純関数。
 * 予約の占有区間 [depart_at, max(free_at, 施術終了+上がりバッファ+移動)] を統合し、
 * 開始点（出勤中=now / 未出勤=出勤予定+移動）から見て「最初に空くギャップ」を返す。
 * 上限はその次に始まる占有区間の開始（＝次予約の出発）／無ければ shiftEnd。
 * 途中に出発すべき予約があれば飛ばさず、その予約の後ろまで開始をずらす（偽の空き窓を出さない）。
 * 用途は「稼働の可視化」＋案内判断（spec 3-5/16章）。
 */
export function computeAvailableWindow(
  row: BoardInput,
  nowMs: number,
  buffers: { afterBufferMin: number; travelMin: number } = DEFAULT_BUFFERS,
): AvailWindow {
  if (row.attendanceState === "done") {
    return { kind: "done", fromMs: null, untilMs: null, gapMin: null, busyNow: false };
  }

  const extraMs = (buffers.afterBufferMin + buffers.travelMin) * MIN;

  // 開始点
  let startPoint: number;
  if (row.attendanceState === "off") {
    if (!row.shiftStart) return { kind: "off", fromMs: null, untilMs: null, gapMin: null, busyNow: false };
    startPoint = row.shiftStart.getTime() + buffers.travelMin * MIN;
  } else {
    startPoint = nowMs;
  }

  // 占有区間 [start, end]（end は free_at と 施術終了+バッファ+移動 の遅い方）
  const intervals = [...row.done, ...row.upcoming]
    .map((j): [number, number] => [
      j.departAt.getTime(),
      Math.max(j.freeAt.getTime(), j.endAt.getTime() + extraMs),
    ])
    .sort((a, b) => a[0] - b[0]);

  const busyNow = intervals.some(([s, e]) => s <= nowMs && nowMs < e);

  // 開始点から最初に空くギャップを探す
  let cursor = startPoint;
  let untilMs: number | null = null;
  for (const [s, e] of intervals) {
    if (s <= cursor) {
      if (e > cursor) cursor = e; // この予約の後ろへ開始をずらす
      continue;
    }
    untilMs = s; // 次の占有が始まる＝ここまで空き
    break;
  }
  if (untilMs === null) untilMs = row.shiftEnd?.getTime() ?? null;

  const availableFrom = cursor;
  const isNow = availableFrom <= nowMs;
  const gapMin = untilMs !== null ? Math.round((untilMs - availableFrom) / MIN) : null;
  const kind = row.attendanceState === "working" && isNow && !busyNow ? "now" : "from";

  return { kind, fromMs: kind === "now" ? null : availableFrom, untilMs, gapMin, busyNow };
}

/** ウィンドウ計算＋「次案内可能が早い順」ソート。done は retired に分離。 */
export function buildBoard(
  rows: BoardInput[],
  nowMs: number,
  buffers: { afterBufferMin: number; travelMin: number } = DEFAULT_BUFFERS,
): { active: BoardRow[]; retired: BoardRow[] } {
  const withWin: BoardRow[] = rows.map((r) => ({ ...r, window: computeAvailableWindow(r, nowMs, buffers) }));
  const retired = withWin.filter((r) => r.window.kind === "done");
  const active = withWin
    .filter((r) => r.window.kind !== "done" && r.window.kind !== "off")
    .sort((a, b) => sortKey(a, nowMs) - sortKey(b, nowMs));
  return { active, retired };
}

function sortKey(r: BoardRow, nowMs: number): number {
  return r.window.fromMs ?? nowMs;
}
