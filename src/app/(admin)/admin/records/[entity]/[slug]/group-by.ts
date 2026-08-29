/**
 * 配列を指定のキー関数でグループ分けするユーティリティ。
 * Array.prototype.group はまだブラウザサポートが不完全なため独自実装。
 */
export function groupBy<T, K>(
  arr: T[],
  keyFn: (item: T) => K,
): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of arr) {
    const key = keyFn(item);
    const group = map.get(key);
    if (group) {
      group.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}
