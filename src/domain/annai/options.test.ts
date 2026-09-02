import { describe, expect, it } from "vitest";
import { indexOptionAvailability, filterOptionsForTherapist } from "./options";

const OPTS = [{ id: "op-a" }, { id: "op-b" }, { id: "op-c" }];

describe("filterOptionsForTherapist（判断#37 OP のセラピスト非対応絞込）", () => {
  it("availability 行が無いオプションは全員に表示（全員対応）", () => {
    const idx = indexOptionAvailability([]);
    expect(filterOptionsForTherapist(OPTS, "t1", idx).map((o) => o.id)).toEqual(["op-a", "op-b", "op-c"]);
  });

  it("制限付きオプションは対応セラピストだけに表示", () => {
    // op-b は t1 のみ対応、op-c は t2 のみ対応、op-a は無制限
    const idx = indexOptionAvailability([
      { option_id: "op-b", therapist_id: "t1" },
      { option_id: "op-c", therapist_id: "t2" },
    ]);
    expect(filterOptionsForTherapist(OPTS, "t1", idx).map((o) => o.id)).toEqual(["op-a", "op-b"]);
    expect(filterOptionsForTherapist(OPTS, "t2", idx).map((o) => o.id)).toEqual(["op-a", "op-c"]);
  });

  it("制限付きだが誰も対応していないセラピストには無制限分のみ", () => {
    const idx = indexOptionAvailability([{ option_id: "op-b", therapist_id: "t1" }]);
    expect(filterOptionsForTherapist(OPTS, "t9", idx).map((o) => o.id)).toEqual(["op-a", "op-c"]);
  });
});
