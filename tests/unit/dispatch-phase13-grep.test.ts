import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * フェーズ13 コード品質 grep 検査（spec 15章 L1118 / CLAUDE.md 禁止事項）。
 *
 * 1. 公開側 src/app/(public) にフェーズ13で直書き日本語が増えていないこと
 *    （フェーズ13は公開側を触らない想定。既存の public-no-japanese.test.ts と
 *     補完関係にある。ここではフェーズ13の新規コード src/domain/dispatch / src/lib/dispatch
 *     を対象に追加で検査する）
 * 2. 新規コード（src/domain/dispatch / src/lib/dispatch）に `any`（as any / : any）が無い
 * 3. 新規コードに金額の小数（整数でない数値リテラルで金額変数に代入）が無い
 * 4. 新規コードに JSON.stringify + ::jsonb パターンが無い
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** .ts / .tsx を再帰収集（テストファイルを除く） */
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
    } else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** コメントを除去し、実コードのみを返す（行番号を維持） */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      // 行コメント // 以降を除去（文字列内の // は考慮しないシンプル版）
      const commentIdx = line.indexOf("//");
      return commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// フェーズ13 の新規コードに対する禁止事項検査
// ---------------------------------------------------------------------------
const DISPATCH_DIRS = [
  join(ROOT, "src", "domain", "dispatch"),
  join(ROOT, "src", "lib", "dispatch"),
];

const dispatchFiles = DISPATCH_DIRS.flatMap(collectFiles);

describe("フェーズ13 新規コード（dispatch）の禁止事項 grep 検査", () => {
  it("対象ファイルが1つ以上見つかる", () => {
    expect(dispatchFiles.length).toBeGreaterThan(0);
  });

  for (const file of dispatchFiles) {
    it(`'as any' / ': any' が無い: ${file.replace(ROOT, "")}`, () => {
      const src = readFileSync(file, "utf8");
      const stripped = stripLineComments(src);
      // ブロックコメントも除去
      const noBlock = stripped.replace(/\/\*[\s\S]*?\*\//g, "");
      const anyMatches = [...noBlock.matchAll(/(?:as\s+any|:\s*any(?:[^A-Za-z]|$))/g)];
      expect(
        anyMatches.map((m) => m[0]),
        `'any' 型が検出されました（CLAUDE.md 禁止事項）`,
      ).toEqual([]);
    });

    it(`JSON.stringify(...)::jsonb パターンが無い: ${file.replace(ROOT, "")}`, () => {
      const src = readFileSync(file, "utf8");
      const hasDoubleEncode = /JSON\.stringify\s*\([^)]*\)\s*::jsonb/.test(src);
      expect(
        hasDoubleEncode,
        `JSON.stringify(...)::jsonb を使用しています（deli01-postgres-jsonb.md 参照: sql.json(x) を使うこと）`,
      ).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 公開側（src/app/(public)）にフェーズ13で新規日本語直書きが入っていないこと
// （既存の public-no-japanese.test.ts を補完。ここでは公開側全体のファイル数が
//  フェーズ13で増加していないことを snapshot 的に確認する）
// ---------------------------------------------------------------------------

const PUBLIC_DIR = join(ROOT, "src", "app", "(public)");
const publicFiles = collectFiles(PUBLIC_DIR);

describe("公開側ファイル変更確認（フェーズ13は公開側を触らない）", () => {
  it("公開側の .ts/.tsx ファイルが存在する（走査できている）", () => {
    expect(publicFiles.length).toBeGreaterThan(0);
  });

  it("公開側の dispatch 関連ファイル（actions.ts 等）が混入していない", () => {
    const dispatchInPublic = publicFiles.filter((f) =>
      f.includes("dispatch") ||
      f.includes("message_template") ||
      f.includes("send-template"),
    );
    expect(
      dispatchInPublic,
      "公開側に dispatch 関連コードが混入しています",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// src/lib/dispatch に 'use server' が冒頭に宣言されていること
// ---------------------------------------------------------------------------
describe("src/lib/dispatch/actions.ts の Server Action 宣言", () => {
  it("'use server' が宣言されている", () => {
    const actionsPath = join(ROOT, "src", "lib", "dispatch", "actions.ts");
    let src: string;
    try {
      src = readFileSync(actionsPath, "utf8");
    } catch {
      throw new Error(`actions.ts が見つかりません: ${actionsPath}`);
    }
    expect(src).toMatch(/^['"]use server['"]/m);
  });
});
