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
  fromMs: number | null; // null = 今すぐ（now 以下）
  untilMs: number | null; // null = 上限なし
  gapMin: number | null;
}
export interface BoardRow extends BoardInput {
  window: AvailWindow;
}

export const DEFAULT_BUFFERS = { afterBufferMin: 30, travelMin: 15 } as const;
const MIN = 60_000;

/**
 * 次案内可能ウィンドウを算出する純関数。
 * 開始 = max(now, 直近に始まった予約の施術終了 + 上がりバッファ + 移動)。
 * 上限 = 開始より後に出発する次予約の depart_at（無ければ shiftEnd）。
 * 用途は「稼働の可視化」＋案内判断。制裁ではない（spec 3-5/16章）。
 */
export function computeAvailableWindow(
  row: BoardInput,
  nowMs: number,
  buffers: { afterBufferMin: number; travelMin: number } = DEFAULT_BUFFERS,
): AvailWindow {
  if (row.attendanceState === "done") return { kind: "done", fromMs: null, untilMs: null, gapMin: null };

  const extraMs = (buffers.afterBufferMin + buffers.travelMin) * MIN;

  let baseFromMs: number;
  if (row.attendanceState === "off") {
    if (!row.shiftStart) return { kind: "off", fromMs: null, untilMs: null, gapMin: null };
    baseFromMs = row.shiftStart.getTime() + buffers.travelMin * MIN;
  } else {
    const started = [...row.done, ...row.upcoming].filter((j) => j.startAt.getTime() <= nowMs);
    const lastEnd = started.length ? Math.max(...started.map((j) => j.endAt.getTime())) : null;
    baseFromMs = lastEnd !== null ? Math.max(nowMs, lastEnd + extraMs) : nowMs;
  }

  const nextDepart = row.upcoming
    .map((j) => j.departAt.getTime())
    .filter((d) => d > baseFromMs)
    .sort((a, b) => a - b)[0];
  const untilMs = nextDepart ?? row.shiftEnd?.getTime() ?? null;

  const isNow = baseFromMs <= nowMs;
  const gapMin = untilMs !== null ? Math.round((untilMs - baseFromMs) / MIN) : null;

  return {
    kind: isNow && row.attendanceState === "working" ? "now" : "from",
    fromMs: isNow ? null : baseFromMs,
    untilMs,
    gapMin,
  };
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
