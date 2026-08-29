/**
 * 禁止語チェック（spec 13-2）。DB にも Next.js にも依存しない純粋関数。
 * 公開ボタンを押したときに呼び出し、マッチした禁止語の一覧を返す。
 * ブロックはしない（警告のみ）。
 */

export function checkBannedWords(text: string, list: string[]): string[] {
  if (!text || list.length === 0) return [];
  const lower = text.toLowerCase();
  const matched = new Set<string>();
  for (const word of list) {
    if (word && lower.includes(word.toLowerCase())) {
      matched.add(word);
    }
  }
  return Array.from(matched);
}
