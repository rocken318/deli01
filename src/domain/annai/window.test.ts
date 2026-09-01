import { describe, expect, it } from "vitest";
import { buildBoard, computeAvailableWindow, type BoardInput, type JobItem } from "./window";

const at = (h: number, m = 0) => new Date(2026, 8, 1, h, m, 0);
const job = (sh: number, eh: number, extra: Partial<JobItem> = {}): JobItem => ({
  id: `${sh}`,
  startAt: at(sh),
  endAt: at(eh),
  departAt: at(sh, -25),
  freeAt: at(eh, 10),
  totalAmount: 13000,
  status: "done",
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
