import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * フェーズ17 コード品質 grep 検査（spec 15章 / CLAUDE.md 禁止事項）。
 *
 * 対象: src/domain/accounting / src/lib/accounting の新規コード。
 * 検査:
 *   1. TypeScript 'any' 型（: any / as any）が無い
 *   2. JSON.stringify(...)::jsonb の二重エンコードが無い
 *   3. 金額変数に小数が使われていない（整数円のみ / spec 禁止事項）
 *   4. 'use client' + postgres の直接 DB アクセスが無い
 *   5. Server Action ファイルが 'use server' を宣言している
 *   6. DB 層（queries.ts）が 'server-only' をインポートしている
 *   7. 公開側（src/app/(public)）に フェーズ17 の会計コードが混入していない
 *   8. 公開側に新たな直書き日本語が混入していない（spec 3-6・13-1・15章）
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

/** ブロックコメント・行コメントを除去して実コードのみを返す */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// フェーズ17 の新規コードディレクトリ
// ---------------------------------------------------------------------------
const PHASE17_DIRS = [
  join(ROOT, "src", "domain", "accounting"),
  join(ROOT, "src", "lib", "accounting"),
];

const phase17Files = PHASE17_DIRS.flatMap(collectFiles);

describe("フェーズ17 新規コードの禁止事項 grep 検査", () => {
  it("対象ファイルが1つ以上見つかる（src/domain/accounting・src/lib/accounting）", () => {
    expect(phase17Files.length).toBeGreaterThan(0);
  });

  for (const file of phase17Files) {
    const relPath = file.replace(ROOT, "");

    it(`TypeScript 'any' 型（as any / : any）が無い: ${relPath}`, () => {
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      // SQL の "= any(...)" は除外（Postgres SQL 構文 / CLAUDE.md 対象外）
      const anyMatches = [...code.matchAll(/(?:as\s+any|:\s*any(?:[^A-Za-z]|$))/g)].filter(
        (m) => !m[0].includes("= any("),
      );
      expect(
        anyMatches.map((m) => m[0]),
        `TypeScript 'any' 型が検出されました (${relPath}) — CLAUDE.md 禁止事項`,
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

    it(`金額変数に小数が使われていない（整数円のみ）: ${relPath}`, () => {
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      const decimalMatches = [
        ...code.matchAll(
          /(?:amount|fee|total|balance|reward|payout|price|surcharge)\s*[=:]\s*[\d]+\.[\d]+/gi,
        ),
      ];
      expect(
        decimalMatches.map((m) => m[0]),
        `金額変数に小数が使われています (${relPath}) — spec: 整数（円）のみ`,
      ).toEqual([]);
    });

    it(`クライアント直 DB アクセスが無い（'use client' + postgres import）: ${relPath}`, () => {
      const src = readFileSync(file, "utf8");
      const isClient = src.includes("'use client'") || src.includes('"use client"');
      const hasPostgres =
        src.includes("import postgres") ||
        src.includes("from 'postgres'") ||
        src.includes('from "postgres"');
      if (isClient && hasPostgres) {
        expect.fail(
          `クライアントコンポーネントから直接 DB を触っています (${relPath}) — CLAUDE.md 禁止事項`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// フェーズ17 Server Action ファイルの 'use server' 宣言確認
// ---------------------------------------------------------------------------
describe("フェーズ17 Server Action ファイルの 'use server' 宣言", () => {
  it("src/lib/accounting/actions.ts が 'use server' を宣言している", () => {
    const path = join(ROOT, "src", "lib", "accounting", "actions.ts");
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/^['"]use server['"]/m);
  });
});

// ---------------------------------------------------------------------------
// DB 層の 'server-only' インポート確認
// ---------------------------------------------------------------------------
describe("DB 層の server-only インポート確認", () => {
  it("src/lib/accounting/queries.ts が 'server-only' をインポートしている", () => {
    const path = join(ROOT, "src", "lib", "accounting", "queries.ts");
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/import\s+["']server-only["']/);
  });

  it("src/lib/accounting/policy.ts が 'server-only' をインポートしている", () => {
    const path = join(ROOT, "src", "lib", "accounting", "policy.ts");
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/import\s+["']server-only["']/);
  });
});

// ---------------------------------------------------------------------------
// 公開側（src/app/(public)）にフェーズ17 コードが混入していないこと
// ---------------------------------------------------------------------------
const PUBLIC_DIR = join(ROOT, "src", "app", "(public)");
const publicFiles = collectFiles(PUBLIC_DIR);

describe("公開側ファイルへのフェーズ17コード混入確認", () => {
  it("公開側の .ts/.tsx ファイルが存在する（走査できている）", () => {
    expect(publicFiles.length).toBeGreaterThan(0);
  });

  it("公開側に accounting 関連ファイルが混入していない", () => {
    const mixed = publicFiles.filter(
      (f) =>
        f.toLowerCase().includes("accounting") ||
        f.toLowerCase().includes("revenue") ||
        f.toLowerCase().includes("ticket") ||
        f.toLowerCase().includes("expense"),
    );
    expect(
      mixed,
      "公開側に会計関連コードが混入しています（CLAUDE.md 禁止: クライアント直DB）",
    ).toEqual([]);
  });

  it("公開側のファイルに直書き日本語が無い（spec 3-6・13-1・15章 / フェーズ17 後も変化なし）", () => {
    // CJK / ひらがな / カタカナ
    const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿]/;
    const violations: string[] = [];
    for (const file of publicFiles) {
      const src = readFileSync(file, "utf8");
      // コメントを除いたコードのみ検査
      const code = stripComments(src);
      if (JAPANESE_RE.test(code)) {
        violations.push(file.replace(ROOT, ""));
      }
    }
    expect(
      violations,
      "公開側テンプレートに直書き日本語が見つかりました（CMS/用語辞書経由にすること）:\n" +
        violations.join("\n"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// フェーズ17 ドメイン関数が domain 層に留まる（lib 層が domain を逆参照しない）
// ---------------------------------------------------------------------------
describe("フェーズ17 アーキテクチャ: domain 関数が lib に依存しない", () => {
  const domainFiles = collectFiles(join(ROOT, "src", "domain", "accounting"));

  it("src/domain/accounting 配下が src/lib を import していない（依存方向）", () => {
    const violations: string[] = [];
    for (const file of domainFiles) {
      const src = readFileSync(file, "utf8");
      // 相対パスで lib を参照しているパターン
      if (/from\s+['"].*\/lib\//.test(src) || /import\s+['"].*\/lib\//.test(src)) {
        violations.push(file.replace(ROOT, ""));
      }
    }
    expect(
      violations,
      "domain 層が lib 層に依存しています（依存方向が逆）:\n" + violations.join("\n"),
    ).toEqual([]);
  });

  it("src/domain/accounting 配下が next.js / react を import していない（DB/FW 非依存）", () => {
    const violations: string[] = [];
    for (const file of domainFiles) {
      const src = readFileSync(file, "utf8");
      if (/from\s+['"]next/.test(src) || /from\s+['"]react/.test(src)) {
        violations.push(file.replace(ROOT, ""));
      }
    }
    expect(
      violations,
      "domain 純粋関数が Next.js/React に依存しています:\n" + violations.join("\n"),
    ).toEqual([]);
  });
});
