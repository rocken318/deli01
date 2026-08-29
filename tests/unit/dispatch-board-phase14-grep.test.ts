import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * フェーズ14 コード品質 grep 検査（spec 15章 L1118 / CLAUDE.md 禁止事項）。
 *
 * 1. 公開側 src/app/(public) にフェーズ14の変更が混入していないこと
 *    （フェーズ14 は admin-ui・therapist マイページのみ。公開側は不変）
 * 2. 新規コード src/domain/dispatch-board / src/lib/dispatch-board に
 *    'any' 型（as any / : any）が無い
 * 3. 新規コードに JSON.stringify(...)::jsonb の二重エンコードが無い
 * 4. 新規コードにクライアントから直接 DB を触るパターンが無い
 *    （'use client' + postgres import の組み合わせ）
 * 5. dispatch-board actions.ts が 'use server' を宣言している
 * 6. therapist-portal-actions.ts が 'use server' を宣言している
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

/** コメントを除去して実コードのみ返す */
function stripComments(src: string): string {
  // ブロックコメント除去
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // 行コメント除去
  return noBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// フェーズ14 の新規コード（dispatch-board）
// ---------------------------------------------------------------------------
const PHASE14_DIRS = [
  join(ROOT, "src", "domain", "dispatch-board"),
  join(ROOT, "src", "lib", "dispatch-board"),
];

const phase14Files = PHASE14_DIRS.flatMap(collectFiles);

describe("フェーズ14 新規コード（dispatch-board）の禁止事項 grep 検査", () => {
  it("対象ファイルが1つ以上見つかる（src/domain/dispatch-board・src/lib/dispatch-board）", () => {
    expect(phase14Files.length).toBeGreaterThan(0);
  });

  for (const file of phase14Files) {
    const relPath = file.replace(ROOT, "");

    it(`'as any' / ': any' が無い: ${relPath}`, () => {
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      const anyMatches = [...code.matchAll(/(?:as\s+any|:\s*any(?:[^A-Za-z]|$))/g)];
      expect(
        anyMatches.map((m) => m[0]),
        `'any' 型が検出されました (${relPath}) — CLAUDE.md 禁止事項`,
      ).toEqual([]);
    });

    it(`JSON.stringify(...)::jsonb の二重エンコードが無い: ${relPath}`, () => {
      const src = readFileSync(file, "utf8");
      const hasDoubleEncode = /JSON\.stringify\s*\([^)]*\)\s*::jsonb/.test(src);
      expect(
        hasDoubleEncode,
        `JSON.stringify(...)::jsonb を使用しています (${relPath}) — sql.json(x) を使うこと`,
      ).toBe(false);
    });

    it(`整数でない金額リテラル（小数金額）が無い: ${relPath}`, () => {
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      // 金額変数（amount/price/fee/total/payout 等）に小数を代入するパターンを検出
      const decimalInAmount = [
        ...code.matchAll(
          /(?:amount|price|fee|total|payout|reward|commission)\s*[=:]\s*[\d]+\.[\d]+/gi,
        ),
      ];
      expect(
        decimalInAmount.map((m) => m[0]),
        `金額に小数が使われています (${relPath}) — spec: 金額は整数（円）のみ`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// dispatch-board Server Actions の宣言確認
// ---------------------------------------------------------------------------
describe("dispatch-board Server Action ファイルの 'use server' 宣言", () => {
  it("src/lib/dispatch-board/actions.ts が 'use server' を宣言している", () => {
    const path = join(ROOT, "src", "lib", "dispatch-board", "actions.ts");
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/^['"]use server['"]/m);
  });

  it("src/lib/dispatch-board/therapist-portal-actions.ts が 'use server' を宣言している", () => {
    const path = join(ROOT, "src", "lib", "dispatch-board", "therapist-portal-actions.ts");
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/^['"]use server['"]/m);
  });
});

// ---------------------------------------------------------------------------
// クライアントコンポーネントから直接 DB を触っていないことの確認
// ---------------------------------------------------------------------------
describe("クライアント直 DB アクセスが無い（CLAUDE.md 禁止事項）", () => {
  it("'use client' + postgres import の組み合わせが dispatch-board ファイルに無い", () => {
    const violations: string[] = [];
    for (const file of phase14Files) {
      const src = readFileSync(file, "utf8");
      if (src.includes("'use client'") || src.includes('"use client"')) {
        if (src.includes("import postgres") || src.includes("from 'postgres'")) {
          violations.push(file.replace(ROOT, ""));
        }
      }
    }
    expect(violations, "クライアントから直接 DB を触っているファイルがあります").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 公開側（src/app/(public)）にフェーズ14のコードが混入していないこと
// （フェーズ14 は admin-ui / therapist マイページのみ。公開側は不変）
// ---------------------------------------------------------------------------
const PUBLIC_DIR = join(ROOT, "src", "app", "(public)");
const publicFiles = collectFiles(PUBLIC_DIR);

describe("公開側ファイルへのフェーズ14コード混入確認", () => {
  it("公開側の .ts/.tsx ファイルが存在する（走査できている）", () => {
    expect(publicFiles.length).toBeGreaterThan(0);
  });

  it("公開側に dispatch-board 関連ファイルが混入していない", () => {
    const mixed = publicFiles.filter((f) =>
      f.includes("dispatch-board") ||
      f.includes("therapist-portal") ||
      f.includes("my-page") ||
      f.includes("mypage"),
    );
    expect(
      mixed,
      "公開側に dispatch-board / therapist portal 関連コードが混入しています",
    ).toEqual([]);
  });

  it("公開側のファイルに直書き日本語が含まれていない（spec 3-6・13-1）", () => {
    // CJK Unified Ideographs（一-鿿）/ ひらがな（぀-ゟ）/ カタカナ（゠-ヿ）
    const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿]/;
    const violations: string[] = [];
    for (const file of publicFiles) {
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      // JSX テキストノードまたは文字列リテラル内の日本語を検出
      // （コメントは除去済み）
      if (JAPANESE_RE.test(code)) {
        violations.push(file.replace(ROOT, ""));
      }
    }
    // 既存の public-no-japanese.test.ts でも検査されているが、ここでは補完的に
    // フェーズ14で新たな日本語が増えていないことを確認する。
    // 既存ファイルが合格済みなら violations は空のはず。
    // 注: 公開側の既存ファイルに日本語があれば仕様違反として報告する
    expect(violations).toEqual([]);
  });
});
