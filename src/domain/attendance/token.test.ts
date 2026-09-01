import { describe, expect, it } from "vitest";
import { signToken, verifyToken, TOKEN_TTL_MS } from "./token";

const SECRET = "test-secret-please-change";
const T0 = 1_800_000_000_000;

describe("attendance token", () => {
  it("直後は検証を通る", () => {
    const tok = signToken(SECRET, T0);
    expect(verifyToken(SECRET, tok, T0)).toEqual({ ok: true });
  });

  it("TTL 内は通る（境界の 1ms 手前）", () => {
    const tok = signToken(SECRET, T0);
    expect(verifyToken(SECRET, tok, T0 + TOKEN_TTL_MS - 1)).toEqual({ ok: true });
  });

  it("TTL 超過は expired", () => {
    const tok = signToken(SECRET, T0);
    expect(verifyToken(SECRET, tok, T0 + TOKEN_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("別の鍵では bad_signature", () => {
    const tok = signToken(SECRET, T0);
    expect(verifyToken("other-secret", tok, T0)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("改ざん payload は bad_signature", () => {
    const tok = signToken(SECRET, T0);
    const [p, s] = tok.split(".");
    const tampered = `${p}x.${s}`;
    const r = verifyToken(SECRET, tampered, T0);
    expect(r.ok).toBe(false);
  });

  it("壊れた形式は malformed", () => {
    expect(verifyToken(SECRET, "not-a-token", T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
