import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 完了条件の機械化（spec 14章フェーズ5 / 13-1 / 15章）:
 * 「公開側テンプレートに直書きの日本語が存在しない」ことを検査する。
 *
 * 対象: src/app/(public)/** と src/lib/public/**。
 * コメント（// ... と /* ... *​/ と JSX {/* ... *​/}）は除外してよい。
 * 文字列/JSX テキストなど、コメント以外に日本語（かな・カナ・漢字・全角句読点）が
 * あれば不合格。誤検出時は該当ファイル:行を出す。
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const TARGET_DIRS = [
  join(ROOT, "src", "app", "(public)"),
  join(ROOT, "src", "lib", "public"),
  // 出勤表の公開読み取り層（フェーズ8）も公開側として走査する
  join(ROOT, "src", "lib", "schedule"),
];

// かな・カナ・漢字（CJK 統合漢字 + 拡張A）・全角句読点/記号（。、「」・々〜！？ 等）
const JAPANESE =
  /[぀-ヿ㐀-䶵一-鿿　-〿＀-￯]/;

/** .ts / .tsx を再帰収集 */
function collectFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      out = out.concat(collectFiles(full));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      // テスト自身は対象外
      if (!name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) out.push(full);
    }
  }
  return out;
}

type Kept = { ch: string; line: number };

/**
 * 文字列/コメントを 1 パスでトークナイズし、コメントだけを取り除いた文字列を
 * （行番号を保ったまま）返す。文字列リテラルの中身は保持する（そこに日本語が
 * あれば不合格にしたい）。行番号を維持するため、除去した文字は改行以外を
 * 空白へ潰し、改行はそのまま残す。
 *
 * 対応する構文:
 * - 行コメント //...
 * - ブロックコメント /* ... *​/（JSX コメント {/* ... *​/} もこれで潰れる）
 * - 文字列 '...' / "..." / `...`（テンプレートリテラル内の ${...} は式として扱う）
 * - 正規表現リテラル /.../（直前トークンから「除算」と区別）
 */
function stripCommentsKeepLines(src: string): Kept[] {
  const kept: Kept[] = [];
  let line = 1;
  let i = 0;
  const n = src.length;

  // 正規表現リテラルの開始判定に使う「直前の有効文字」
  let prevSignificant = "";

  const push = (ch: string) => {
    kept.push({ ch, line });
    if (ch !== " ") prevSignificant = ch;
  };
  const advanceLine = (ch: string) => {
    if (ch === "\n") line += 1;
  };

  // テンプレートリテラルのネスト（${...} 内でさらに `...`）を追う簡易スタック
  // 要素: "template"（バッククォート内） / "expr"（${...} 内）
  const stack: string[] = [];

  while (i < n) {
    const ch = src[i]!;
    const next = i + 1 < n ? src[i + 1]! : "";
    const inTemplate = stack.length > 0 && stack[stack.length - 1] === "template";

    if (inTemplate) {
      // テンプレートリテラル本文。${ で式へ、` で終了。
      if (ch === "\\") {
        push(ch);
        if (next) {
          advanceLine(next);
          push(next);
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === "`") {
        push(ch);
        stack.pop();
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        push(ch);
        push("{");
        stack.push("expr");
        i += 2;
        continue;
      }
      advanceLine(ch);
      push(ch); // 本文（日本語があれば残す）
      i += 1;
      continue;
    }

    // 通常のコード文脈（トップレベル or ${...} 式内）
    // 行コメント
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i += 1;
      continue; // 改行はループ先頭で処理
    }
    // ブロックコメント
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        advanceLine(src[i]!);
        i += 1;
      }
      i += 2; // 閉じ */
      continue;
    }
    // 文字列 ' または "
    if (ch === "'" || ch === '"') {
      const quote = ch;
      push(ch);
      i += 1;
      while (i < n) {
        const c = src[i]!;
        if (c === "\\") {
          push(c);
          const c2 = src[i + 1];
          if (c2 !== undefined) {
            advanceLine(c2);
            push(c2);
            i += 2;
            continue;
          }
          i += 1;
          continue;
        }
        if (c === quote) {
          push(c);
          i += 1;
          break;
        }
        advanceLine(c);
        push(c); // 中身は保持（日本語検出対象）
        i += 1;
      }
      continue;
    }
    // テンプレートリテラル開始
    if (ch === "`") {
      push(ch);
      stack.push("template");
      i += 1;
      continue;
    }
    // ${...} 式の終端
    if (ch === "}" && stack.length > 0 && stack[stack.length - 1] === "expr") {
      push(ch);
      stack.pop();
      i += 1;
      continue;
    }
    // 正規表現リテラル（直前が値/識別子で終わっていなければ開始とみなす）
    if (ch === "/" && canStartRegex(prevSignificant)) {
      push(ch);
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = src[i]!;
        if (c === "\\") {
          push(c);
          const c2 = src[i + 1];
          if (c2 !== undefined) {
            advanceLine(c2);
            push(c2);
            i += 2;
            continue;
          }
          i += 1;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          push(c);
          i += 1;
          break;
        } else if (c === "\n") {
          // 不正な正規表現。安全側で打ち切り。
          break;
        }
        push(c);
        i += 1;
      }
      continue;
    }

    // 通常文字
    advanceLine(ch);
    // 空白は prevSignificant を更新しない（push 経由で制御）
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      kept.push({ ch, line: ch === "\n" ? line - 1 : line });
    } else {
      push(ch);
    }
    i += 1;
  }
  return kept;
}

/** `/` が正規表現の開始になり得るか（直前の有効文字から判定） */
function canStartRegex(prev: string): boolean {
  if (prev === "") return true;
  // 直前が値の終わり（識別子/数値/閉じ括弧）なら除算とみなす
  if (/[A-Za-z0-9_$)\]]/.test(prev)) return false;
  return true;
}

describe("公開側に直書きの日本語が無い（完了条件 / spec 14章フェーズ5）", () => {
  const files = TARGET_DIRS.flatMap(collectFiles);

  it("対象ファイルが1つ以上見つかる", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`日本語リテラルを含まない: ${file.replace(ROOT, "")}`, () => {
      const src = readFileSync(file, "utf8");
      const kept = stripCommentsKeepLines(src);
      // 行ごとに日本語文字を集計
      const offenderLines = new Map<number, string>();
      for (const { ch, line } of kept) {
        if (JAPANESE.test(ch)) {
          offenderLines.set(line, (offenderLines.get(line) ?? "") + ch);
        }
      }
      const offenders = Array.from(offenderLines.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([line, text]) => ({ line, text }));
      const rel = file.replace(ROOT, "");
      expect(
        offenders,
        `日本語の直書きが見つかりました（CMS/用語辞書経由にすること）:\n` +
          offenders.map((o) => `  ${rel}:${o.line}  「${o.text}」`).join("\n"),
      ).toEqual([]);
    });
  }
});
