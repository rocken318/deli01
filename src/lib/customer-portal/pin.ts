import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 会員ページ（顧客ポータル）の暗証番号ハッシュ（発注者決定 2026-09-06）。
 * scrypt で "salt:hash"（ともに hex）を作る。平文 PIN は保存しない。
 * PIN は数字4〜6桁を想定（総当り耐性は弱いので、ログイン側で試行を絞るのが望ましい）。
 */

const KEYLEN = 32;

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  const actual = scryptSync(pin, Buffer.from(saltHex, "hex"), KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
