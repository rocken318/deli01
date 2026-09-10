import { describe, it, expect } from "vitest";
import {
  SEND_STATES, RETURN_STATES, statesForSlot, initialStateForSlot,
  isValidState, isDoneState, kindForSlot,
} from "./leg-states";

describe("leg-states", () => {
  it("送りは6状態・この順", () => {
    expect(SEND_STATES).toEqual(["予定","送り中","合流確認中","インコール待機中","バック中","完了"]);
  });
  it("帰りは4状態・この順", () => {
    expect(RETURN_STATES).toEqual(["向かい中","アウト待ち","バック中","完了"]);
  });
  it("初期状態: 送り=予定 / 帰り=向かい中", () => {
    expect(initialStateForSlot("send")).toBe("予定");
    expect(initialStateForSlot("return")).toBe("向かい中");
  });
  it("statesForSlot", () => {
    expect(statesForSlot("send")).toEqual(SEND_STATES);
    expect(statesForSlot("return")).toEqual(RETURN_STATES);
  });
  it("isValidState", () => {
    expect(isValidState("send", "合流確認中")).toBe(true);
    expect(isValidState("send", "アウト待ち")).toBe(false);
    expect(isValidState("return", "アウト待ち")).toBe(true);
  });
  it("isDoneState", () => {
    expect(isDoneState("完了")).toBe(true);
    expect(isDoneState("送り中")).toBe(false);
  });
  it("kindForSlot", () => {
    expect(kindForSlot("send")).toBe("reservation_send");
    expect(kindForSlot("return")).toBe("reservation_return");
  });
});
