import { describe, expect, it } from "vitest";
import { buildBoard, buildDayTimeline, computeAvailableWindow, DEFAULT_BUFFERS, type BoardInput, type JobItem } from "./window";

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
  ngNote: null,
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

  it("短すぎる隙間もスキップせず『今から』を出す＋tooShort 警告（発注者 2026-09-11）", () => {
    // 次予約が 12:00（出発11:35）→ 11:00〜11:35=35分の隙間は 60分コース+バッファに満たない。
    // 以前は次予約の後ろへ飛ばしていた（＝今行けるのに2時間後バグ）。
    // 新仕様: 今すぐ空いていれば正直に now を出し、短い時は tooShort=true で警告に回す。
    const row: BoardInput = {
      ...base,
      upcoming: [
        job(12, 13, { status: "confirmed", departAt: at(11, 35), freeAt: at(13, 10) }),
      ],
    };
    // now=11:00（出勤中、まだ接客なし）
    const w = computeAvailableWindow(row, at(11).getTime(), DEFAULT_BUFFERS, 60);
    expect(w.kind).toBe("now");
    expect(w.fromMs).toBeNull(); // 今すぐ
    expect(w.untilMs).toBe(at(11, 35).getTime());
    expect(w.gapMin).toBe(35);
    expect(w.tooShort).toBe(true); // 35 < 60 → 警告
  });

  it("十分な隙間は tooShort=false", () => {
    // 次予約が 14:00（出発13:35）→ 11:00〜13:35=155分の隙間は 60分コースに十分
    const row: BoardInput = {
      ...base,
      upcoming: [
        job(14, 15, { status: "confirmed", departAt: at(13, 35), freeAt: at(15, 10) }),
      ],
    };
    const w = computeAvailableWindow(row, at(11).getTime(), DEFAULT_BUFFERS, 60);
    // 隙間は十分 → 今すぐ(now)、上限は 13:35（次予約の出発）、警告なし
    expect(w.kind).toBe("now");
    expect(w.untilMs).toBe(at(13, 35).getTime());
    expect(w.tooShort).toBe(false);
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

describe("buildDayTimeline", () => {
  // 固定タイムスタンプ: 2026-09-01 14:00 (テストの時計に依存しない)
  const now1400 = at(14).getTime();

  it("予約2件＋シフト → job,gap,job,gap の並びと minutes が正しい", () => {
    // job1: 出発11:35, 終了12:00+extra(45分)=12:45
    // job2: 出発15:35, 終了16:00+extra(45分)=16:45
    const row: BoardInput = {
      ...base,
      done: [
        job(12, 13, { departAt: at(11, 35), freeAt: at(13, 10) }),
      ],
      upcoming: [
        job(16, 17, { status: "confirmed", departAt: at(15, 35), freeAt: at(17, 10) }),
      ],
    };
    // extraMs = (30+15)*60000 = 45min
    // job1 occupancy: [11:35, max(13:10, 13:00+45min=13:45)] = [11:35, 13:45]
    // job2 occupancy: [15:35, max(17:10, 17:00+45min=17:45)] = [15:35, 17:45]
    // rangeStart = max(14:00, 11:00+15=11:15) = 14:00
    // rangeEnd = 23:00
    // cursor=14:00, job1.endMs=13:45 < 14:00 → skipped
    // job2.startMs=15:35 > cursor=14:00 → gap [14:00, 15:35] = 95min
    // job2 segment [15:35, 17:45] = 130min
    // trailing gap [17:45, 23:00] = 315min
    const segs = buildDayTimeline(row, now1400, DEFAULT_BUFFERS, 0);
    expect(segs.map((s) => s.kind)).toEqual(["gap", "job", "gap"]);
    expect(segs[0]!.minutes).toBe(95);
    expect(segs[1]!.minutes).toBe(130);
    expect(segs[2]!.minutes).toBe(315);
  });

  it("予約なし → gap 1本（範囲まるごと）", () => {
    const segs = buildDayTimeline(base, at(14).getTime(), DEFAULT_BUFFERS, 0);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe("gap");
    // rangeStart = max(14:00, 11:15) = 14:00, rangeEnd = 23:00 → 540min
    expect(segs[0]!.minutes).toBe(540);
    expect(segs[0]!.startMs).toBe(at(14).getTime());
    expect(segs[0]!.endMs).toBe(at(23).getTime());
  });

  it("上がり(done) → 空配列", () => {
    const segs = buildDayTimeline({ ...base, attendanceState: "done" }, at(14).getTime());
    expect(segs).toEqual([]);
  });

  it("短い隙間に tooShort=true が付く", () => {
    // 次予約が 15:00 出発（14:35）→ now=14:00 から 14:35=35分の隙間、minBookableMin=60
    const row: BoardInput = {
      ...base,
      upcoming: [
        job(15, 16, { status: "confirmed", departAt: at(14, 35), freeAt: at(16, 10) }),
      ],
    };
    const segs = buildDayTimeline(row, at(14).getTime(), DEFAULT_BUFFERS, 60);
    const gap = segs.find((s) => s.kind === "gap" && s.tooShort);
    expect(gap).toBeDefined();
    expect(gap!.tooShort).toBe(true);
    expect(gap!.minutes).toBeLessThan(60);
  });

  it("今より前に始まる gap は isNow=true", () => {
    // now=14:00, rangeStart=14:00 (working), 最初の gap は rangeStart=14:00=now → isNow
    const segs = buildDayTimeline(base, at(14).getTime(), DEFAULT_BUFFERS, 0);
    expect(segs[0]!.kind).toBe("gap");
    expect(segs[0]!.isNow).toBe(true);
  });

  it("重なる予約は1つの job に統合される", () => {
    // job1: 出発12:00, 終了14:00+45min=14:45
    // job2: 出発13:30 → job1.endMs=14:45 > 13:30 → 統合
    const row: BoardInput = {
      ...base,
      done: [
        job(13, 14, { departAt: at(12), freeAt: at(14, 15) }),
        job(14, 15, { departAt: at(13, 30), freeAt: at(15, 15) }),
      ],
    };
    const segs = buildDayTimeline(row, at(11).getTime(), DEFAULT_BUFFERS, 0);
    const jobs = segs.filter((s) => s.kind === "job");
    expect(jobs).toHaveLength(1);
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
    ngNote: null,
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
