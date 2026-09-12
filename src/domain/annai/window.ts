export interface JobItem {
  id: string;
  startAt: Date;
  endAt: Date;
  departAt: Date;
  freeAt: Date;
  totalAmount: number;
  status: string;
  /** 清算（集金照合）を締めた時刻。null=未清算（done なら要清算）。P2 の reconciled_at を集約。 */
  reconciledAt: Date | null;
}
export type AttendanceState = "off" | "working" | "done";
export interface BoardInput {
  therapistId: string;
  slug: string;
  name: string;
  ngNote: string | null;
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
  /** 空きが minBookableMin 未満（＝最短コースが入りにくい短い枠）。案内はできるが要注意の警告フラグ。 */
  tooShort: boolean;
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
  minBookableMin = 0,
): AvailWindow {
  if (row.attendanceState === "done") {
    return { kind: "done", fromMs: null, untilMs: null, gapMin: null, busyNow: false, tooShort: false };
  }

  const extraMs = (buffers.afterBufferMin + buffers.travelMin) * MIN;

  // 開始点
  let startPoint: number;
  if (row.attendanceState === "off") {
    if (!row.shiftStart) return { kind: "off", fromMs: null, untilMs: null, gapMin: null, busyNow: false, tooShort: false };
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

  // 開始点から最初に空くギャップを探す。
  // ★短い隙間もスキップしない（今すぐ行けるのに次予約後へ飛ばさない / 発注者 2026-09-11）。
  //   短い場合は tooShort フラグで警告表示に回し、案内自体は正直に「今から」を出す。
  let cursor = startPoint;
  let untilMs: number | null = null;
  for (const [s, e] of intervals) {
    if (s <= cursor) {
      if (e > cursor) cursor = e; // 現在占有中/直近の予約の後ろへ開始をずらす
      continue;
    }
    // Gap found: cursor..s is free. 最早の空きとして採用（短くてもスキップしない）。
    untilMs = s; // 次の占有が始まる＝ここまで空き
    break;
  }
  if (untilMs === null) untilMs = row.shiftEnd?.getTime() ?? null;

  const availableFrom = cursor;
  const isNow = availableFrom <= nowMs;
  const gapMin = untilMs !== null ? Math.round((untilMs - availableFrom) / MIN) : null;
  const tooShort = minBookableMin > 0 && gapMin !== null && gapMin < minBookableMin;
  const kind = row.attendanceState === "working" && isNow && !busyNow ? "now" : "from";

  return { kind, fromMs: kind === "now" ? null : availableFrom, untilMs, gapMin, busyNow, tooShort };
}

// ---------------------------------------------------------------------------
// buildDayTimeline: その日の帯（予約→空き→予約→…）を返す純関数
// ---------------------------------------------------------------------------

export type TimelineSegmentKind = "job" | "gap" | "off";
export interface TimelineSegment {
  kind: TimelineSegmentKind;
  startMs: number;
  endMs: number;
  minutes: number;
  /** kind==='job' のとき元の予約 */
  job?: JobItem;
  /** kind==='gap' のとき、最短コースが入らない短い隙間なら true */
  tooShort?: boolean;
  /** kind==='gap' のとき、現在時刻より前に始まる（＝今すぐ案内できる）なら true */
  isNow?: boolean;
}

/**
 * その日の帯（予約→空き→予約→…）を返す純関数。
 * 範囲は [max(now, shiftStart+travel), shiftEnd]。占有区間は computeAvailableWindow と同じ定義。
 * 重なる予約は統合してひとつの job セグメントにまとめる（表示が壊れないように）。
 */
export function buildDayTimeline(
  row: BoardInput,
  nowMs: number,
  buffers: { afterBufferMin: number; travelMin: number } = DEFAULT_BUFFERS,
  minBookableMin = 0,
): TimelineSegment[] {
  if (row.attendanceState === "done") return [];
  if (row.attendanceState === "off" && !row.shiftStart) return [];

  const extraMs = (buffers.afterBufferMin + buffers.travelMin) * MIN;

  // 範囲の開始
  let rangeStart: number;
  if (row.attendanceState === "off") {
    // shiftStart は null でないことを上で確認済み
    rangeStart = row.shiftStart!.getTime() + buffers.travelMin * MIN;
  } else {
    // working: max(now, shiftStart+travel)
    const shiftWithTravel = row.shiftStart ? row.shiftStart.getTime() + buffers.travelMin * MIN : nowMs;
    rangeStart = Math.max(nowMs, shiftWithTravel);
  }

  // 範囲の終了: shiftEnd があればそれ、なければ最後の占有区間の終わり
  const allJobs = [...row.done, ...row.upcoming];

  // 占有区間 [departAt, max(freeAt, endAt+extra)] を構築・ソート・統合
  const rawIntervals = allJobs
    .map((j): [number, number, JobItem] => [
      j.departAt.getTime(),
      Math.max(j.freeAt.getTime(), j.endAt.getTime() + extraMs),
      j,
    ])
    .sort((a, b) => a[0] - b[0]);

  // 統合: 重なる区間をマージし、代表 job（最初のもの）を保持
  const merged: { startMs: number; endMs: number; job: JobItem }[] = [];
  for (const [s, e, j] of rawIntervals) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ startMs: s, endMs: e, job: j });
    } else if (s <= last.endMs) {
      // 重なりあり → 統合（endMs を延ばす）
      last.endMs = Math.max(last.endMs, e);
    } else {
      merged.push({ startMs: s, endMs: e, job: j });
    }
  }

  // 範囲終了: shiftEnd || 最後の占有の終わり || rangeStart（フォールバック）
  const lastMerged = merged[merged.length - 1];
  const lastEnd = lastMerged ? lastMerged.endMs : rangeStart;
  const rangeEnd = row.shiftEnd ? row.shiftEnd.getTime() : lastEnd;

  const segments: TimelineSegment[] = [];

  let cursor = rangeStart;
  for (const occ of merged) {
    // 範囲より後ろの占有はスキップ
    if (occ.startMs >= rangeEnd) break;
    // 範囲より前に完全に終わる占有はスキップ
    if (occ.endMs <= rangeStart) continue;

    // 占有開始より前に gap がある場合
    const gapStart = cursor;
    const gapEnd = Math.max(cursor, occ.startMs);
    if (gapEnd > gapStart) {
      const minutes = Math.round((gapEnd - gapStart) / MIN);
      if (minutes > 0) {
        segments.push({
          kind: "gap",
          startMs: gapStart,
          endMs: gapEnd,
          minutes,
          tooShort: minBookableMin > 0 && minutes < minBookableMin,
          isNow: gapStart <= nowMs,
        });
      }
    }

    // job セグメント（範囲にクリップ）
    const jobStart = Math.max(occ.startMs, rangeStart);
    const jobEnd = Math.min(occ.endMs, rangeEnd);
    if (jobEnd > jobStart) {
      const minutes = Math.round((jobEnd - jobStart) / MIN);
      segments.push({
        kind: "job",
        startMs: jobStart,
        endMs: jobEnd,
        minutes,
        job: occ.job,
      });
    }
    cursor = Math.max(cursor, occ.endMs);
  }

  // 最後の占有の後〜rangeEnd の gap
  if (cursor < rangeEnd) {
    const minutes = Math.round((rangeEnd - cursor) / MIN);
    if (minutes > 0) {
      segments.push({
        kind: "gap",
        startMs: cursor,
        endMs: rangeEnd,
        minutes,
        tooShort: minBookableMin > 0 && minutes < minBookableMin,
        isNow: cursor <= nowMs,
      });
    }
  }

  return segments;
}

/** ウィンドウ計算＋「次案内可能が早い順」ソート。done は retired に分離。 */
export function buildBoard(
  rows: BoardInput[],
  nowMs: number,
  buffers: { afterBufferMin: number; travelMin: number } = DEFAULT_BUFFERS,
  minBookableMin = 0,
): { active: BoardRow[]; retired: BoardRow[] } {
  const withWin: BoardRow[] = rows.map((r) => ({ ...r, window: computeAvailableWindow(r, nowMs, buffers, minBookableMin) }));
  const retired = withWin.filter((r) => r.window.kind === "done");
  const active = withWin
    .filter((r) => r.window.kind !== "done" && r.window.kind !== "off")
    .sort((a, b) => sortKey(a, nowMs) - sortKey(b, nowMs));
  return { active, retired };
}

function sortKey(r: BoardRow, nowMs: number): number {
  return r.window.fromMs ?? nowMs;
}
