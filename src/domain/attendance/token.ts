import { createHmac, timingSafeEqual } from "node:crypto";

/** トークンの有効期間（ms）。キオスクは 45秒ごとに更新（重複窓で切れ目なし）。 */
export const TOKEN_TTL_MS = 60_000;

export type TokenCheck =
  | { ok: true }
  | { ok: false; reason: "expired" | "bad_signature" | "malformed" };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(secret: string, payload: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

/** payload = base64url(JSON{iat,exp})、token = payload + "." + signature */
export function signToken(secret: string, nowMs: number, ttlMs: number = TOKEN_TTL_MS): string {
  const payload = b64url(Buffer.from(JSON.stringify({ iat: nowMs, exp: nowMs + ttlMs })));
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyToken(secret: string, token: string, nowMs: number): TokenCheck {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts;

  const expected = sign(secret, payload);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let decoded: { iat: number; exp: number };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof decoded.exp !== "number") return { ok: false, reason: "malformed" };
  if (nowMs >= decoded.exp) return { ok: false, reason: "expired" };
  return { ok: true };
}
