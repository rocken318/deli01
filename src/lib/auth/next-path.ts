/**
 * ログイン後リダイレクト先の next パラメータをサニタイズする。
 * オープンリダイレクト防止: 同一オリジンの相対パス（"/" 始まり・"//" でない・
 * 制御文字やバックスラッシュを含まない）だけを許可し、それ以外は fallback に倒す。
 * fallback は既定 "/admin"。ロール別の着地先（例: therapist は "/mypage"）を
 * 使いたい場合は呼び出し側から渡す。
 */
export function sanitizeNext(
  raw: string | undefined | null,
  fallback = "/admin",
): string {
  if (!raw) return fallback;
  // 制御文字（改行・タブ等）・DEL・バックスラッシュを含むものは拒否
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || raw[i] === "\\") return fallback;
  }
  // "/" 始まり かつ "//"（プロトコル相対）でないこと
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}

/** ロール別のログイン後の既定着地先。therapist はマイページ、それ以外は管理。 */
export function defaultDestForRole(role: string | undefined | null): string {
  return role === "therapist" ? "/mypage" : "/admin";
}
