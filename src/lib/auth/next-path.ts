/**
 * ログイン後リダイレクト先の next パラメータをサニタイズする。
 * オープンリダイレクト防止: 同一オリジンの相対パス（"/" 始まり・"//" でない・
 * 制御文字やバックスラッシュを含まない）だけを許可し、それ以外は "/admin" に倒す。
 */
export function sanitizeNext(raw: string | undefined | null): string {
  const fallback = "/admin";
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
