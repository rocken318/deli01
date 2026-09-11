import { describe, it, expect } from "vitest";
import { deriveHotelRecord } from "./record";

describe("deriveHotelRecord", () => {
  it("is_blocked=true は blocked(✖)", () => {
    expect(deriveHotelRecord(true, null)).toBe("blocked");
    expect(deriveHotelRecord(true, "△要注意")).toBe("blocked");
  });
  it("entry_note が △ で始まると caution(△)", () => {
    expect(deriveHotelRecord(false, "△要注意 1F外迎え")).toBe("caution");
  });
  it("それ以外は ok(〇)", () => {
    expect(deriveHotelRecord(false, "1F外迎え")).toBe("ok");
    expect(deriveHotelRecord(false, null)).toBe("ok");
  });
});
