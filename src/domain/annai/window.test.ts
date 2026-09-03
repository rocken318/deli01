import { describe, expect, it } from "vitest";
import { buildBoard, computeAvailableWindow, DEFAULT_BUFFERS, type BoardInput, type JobItem } from "./window";

const at = (h: number, m = 0) => new Date(2026, 8, 1, h, m, 0);
const job = (sh: number, eh: number, extra: Partial<JobItem> = {}): JobItem => ({
  id: `${sh}`,
  startAt: at(sh),
  endAt: at(eh),
  departAt: at(sh, -25),
  freeAt: at(eh, 10),
  totalAmount: 13000,
  status: "done",
  reconciledAt: null,
  ...extra,
});
const base: BoardInput = {
  therapistId: "t",
  slug: "yuna",
  name: "ゆな",
  attendanceState: "working",
  shiftStart: at(11),
  shiftEnd: at(23),
  lateManual: false,
  done: [],
  upcoming: [],
};

describe("computeAvailableWindow", () => {
  it("出勤中・予約なし → 今すぐ・上限は shiftEnd まで", () => {
    const w = computeAvailableWindow(base, at(16).getTime());
    expect(w.kind).toBe("now");
    expect(w.fromMs).toBeNull();
    expect(w.untilMs).toBe(at(23).getTime());
  });

  it("done×2 の後 → 最後の終了+30+移動15 から、上限は次予約の出発", () => {
    const row: BoardInput = {
      ...base,
      done: [job(11, 12), job(14, 15)],
      upcoming: [job(18, 19, { status: "confirmed", departAt: at(17, 35) })],
    };
    const w = computeAvailableWindow(row, at(15, 20).getTime());
    expect(w.fromMs).toBe(at(15, 45).getTime());
    expect(w.untilMs).toBe(at(17, 35).getTime());
    expect(w.gapMin).toBe(110);
    expect(w.kind).toBe("from");
  });

  it("退勤済 → done", () => {
    const w = computeAvailableWindow({ ...base, attendanceState: "done" }, at(23).getTime());
    expect(w.kind).toBe("done");
  });

  it("未出勤(off) → off", () => {
    const w = computeAvailableWindow(
      { ...base, attendanceState: "off", shiftStart: null },
      at(16).getTime(),
    );
    expect(w.kind).toBe("off");
  });

  it("未出勤だが shift あり → 出勤予定+移動の見込み(from)", () => {
    const w = computeAvailableWindow({ ...base, attendanceState: "off" }, at(9).getTime());
    expect(w.kind).toBe("from");
    expect(w.fromMs).toBe(at(11, 15).getTime());
  });

  it("移動中(enroute: 次予約へ出発済み) → 今すぐにしない・busyNow", () => {
    // done 16:00終了、18:00予約へ 17:35 出発、now=17:50（占有区間内）
    const row: BoardInput = {
      ...base,
      done: [job(15, 16)],
      upcoming: [job(18, 19, { status: "confirmed", departAt: at(17, 35), freeAt: at(19, 10) })],
    };
    const w = computeAvailableWindow(row, at(17, 50).getTime());
    expect(w.busyNow).toBe(true);
    expect(w.kind).toBe("from");
    expect(w.fromMs).not.toBeNull();
    expect(w.fromMs!).toBeGreaterThan(at(17, 50).getTime()); // 次予約の後ろ
  });

  it("連続予約が詰まっている → 間の偽の空き窓を出さない", () => {
    // done 17:00終了 と 17:30開始(出発17:05)の予約が連続。間に空きは無い。
    const row: BoardInput = {
      ...base,
      done: [job(16, 17)],
      upcoming: [job(17, 18, {
        status: "confirmed",
        startAt: at(17, 30),
        endAt: at(18, 30),
        departAt: at(17, 5),
        freeAt: at(18, 40),
      })],
    };
    const w = computeAvailableWindow(row, at(16, 50).getTime());
    // 17:45 のような間の空きを出さず、2件目の後ろまでずれる
    expect(w.fromMs).not.toBeNull();
    expect(w.fromMs!).toBeGreaterThanOrEqual(at(18, 40).getTime());
  });

  it("minBookableMin: 短すぎる隙間はスキップして次予約の後ろを返す", () => {
    // 次予約が 12:00（出発11:35）→ 11:00〜11:35=35分の隙間は 60分コース+バッファ(50分)に満たない
    // minBookableMin=60 なら次予約の後ろへずれる
    const row: BoardInput = {
      ...base,
      upcoming: [
        job(12, 13, { status: "confirmed", departAt: at(11, 35), freeAt: at(13, 10) }),
      ],
    };
    // now=11:00（出勤中、まだ接客なし）
    const w = computeAvailableWindow(row, at(11).getTime(), DEFAULT_BUFFERS, 60);
    // 11:00〜11:35 の35分隙間はスキップ → 次予約終了後 freeAt=13:10 から
    expect(w.fromMs).not.toBeNull();
    expect(w.fromMs!).toBeGreaterThanOrEqual(at(13, 10).getTime());
    expect(w.kind).toBe("from");
  });

  it("minBookableMin: 十分な隙間はそのまま通す", () => {
    // 次予約が 14:00（出発13:35）→ 11:00〜13:35=155分の隙間は 60分コースに十分
    const row: BoardInput = {
      ...base,
      upcoming: [
        job(14, 15, { status: "confirmed", departAt: at(13, 35), freeAt: at(15, 10) }),
      ],
    };
    const w = computeAvailableWindow(row, at(11).getTime(), DEFAULT_BUFFERS, 60);
    // 隙間は十分 → 今すぐ(now)、上限は 13:35（次予約の出発）
    expect(w.kind).toBe("now");
    expect(w.untilMs).toBe(at(13, 35).getTime());
  });

  it("minBookableMin: 予約なし・シフト残り時間がゼロ扱い → minBookableMin=0 と同じ（予約なしは常に案内可能）", () => {
    // 予約なし → 隙間はシフト終了まで、minBookableMin があっても制約なし
    const w = computeAvailableWindow(base, at(16).getTime(), DEFAULT_BUFFERS, 60);
    expect(w.kind).toBe("now");
    expect(w.untilMs).toBe(at(23).getTime());
  });

  it("minBookableMin省略=0: 従来動作（短い隙間もそのまま）", () => {
    // 次予約が 11:30（出発11:05）→ 11:00〜11:05=5分しかないが minBookableMin=0 なら出す
    const row: BoardInput = {
      ...base,
      upcoming: [
        job(12, 13, { status: "confirmed", departAt: at(11, 5), freeAt: at(13, 10) }),
      ],
    };
    const w = computeAvailableWindow(row, at(11).getTime());
    // minBookableMin省略=0 → 短くても now/from を出す（既存動作）
    expect(w.kind).toBe("now");
    expect(w.untilMs).toBe(at(11, 5).getTime());
    expect(w.gapMin).toBe(5);
  });
});

describe("buildBoard", () => {
  const mk = (
    slug: string,
    state: "working" | "done",
    done: JobItem[] = [],
    upcoming: JobItem[] = [],
  ): BoardInput => ({
    therapistId: slug,
    slug,
    name: slug,
    attendanceState: state,
    shiftStart: at(11),
    shiftEnd: at(23),
    lateManual: false,
    done,
    upcoming,
  });

  it("今すぐの子が上、上がりは retired に分離", () => {
    const now = at(15, 20).getTime();
    const ren = mk("ren", "working"); // 予約なし=今すぐ
    const yuna = mk(
      "yuna",
      "working",
      [job(11, 12), job(14, 15)],
      [job(18, 19, { status: "confirmed", departAt: at(17, 35) })],
    ); // 15:45〜
    const kohar = mk("kohar", "done");
    const { active, retired } = buildBoard([yuna, ren, kohar], now);
    expect(active.map((r) => r.slug)).toEqual(["ren", "yuna"]);
    expect(retired.map((r) => r.slug)).toEqual(["kohar"]);
  });
});
