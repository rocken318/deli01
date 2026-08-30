import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * フェーズ16 コード品質 grep 検査（spec 15章 / CLAUDE.md 禁止事項）。
 *
 * 1. フェーズ16 新規コード（src/domain/points / src/lib/points /
 *    src/lib/handover / src/lib/nomination）に禁止事項が無い:
 *    - TypeScript の `any` 型（as any / : any）
 *    - JSON.stringify(...)::jsonb の二重エンコード
 *    - 小数金額（amount/points/fee 変数への小数代入）
 *    - クライアントから直接 DB を触るパターン（'use client' + postgres）
 * 2. フェーズ16 の Server Actions が 'use server' を宣言している
 * 3. 公開側（src/app/(public)）にフェーズ16 の新規コードが混入していない
 *    （フェーズ16 は admin-ui / therapist マイページのみ。公開側は不変）
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
// フェーズ16 の新規コードディレクトリ
// ---------------------------------------------------------------------------
const PHASE16_DIRS = [
  join(ROOT, "src", "domain", "points"),
  join(ROOT, "src", "lib", "points"),
  join(ROOT, "src", "lib", "handover"),
  join(ROOT, "src", "lib", "nomination"),
];

const phase16Files = PHASE16_DIRS.flatMap(collectFiles);

describe("フェーズ16 新規コードの禁止事項 grep 検査", () => {
  it("対象ファイルが1つ以上見つかる（src/domain/points・src/lib/points・handover・nomination）", () => {
    expect(phase16Files.length).toBeGreaterThan(0);
  });

  for (const file of phase16Files) {
    const relPath = file.replace(ROOT, "");

    it(`TypeScript 'any' 型（as any / : any）が無い: ${relPath}`, () => {
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      // SQL の "= any(...)" は除外（Postgres SQL 構文 / CLAUDE.md 対象外）
      // TypeScript の型アノテーションとして使われる "as any" / ": any" のみ検出
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

    it(`金額・ポイント変数に小数が使われていない: ${relPath}`, () => {
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      const decimalMatches = [
        ...code.matchAll(
          /(?:amount|points|fee|total|balance|reward|payout|price)\s*[=:]\s*[\d]+\.[\d]+/gi,
        ),
      ];
      expect(
        decimalMatches.map((m) => m[0]),
        `金額・ポイントに小数が使われています (${relPath}) — spec: 整数（円・P）のみ`,
      ).toEqual([]);
    });

    it(`クライアント直 DB アクセスが無い（'use client' + postgres import）: ${relPath}`, () => {
      const src = readFileSync(file, "utf8");
      const isClient = src.includes("'use client'") || src.includes('"use client"');
      const hasPostgres =
        src.includes("import postgres") || src.includes("from 'postgres'") || src.includes('from "postgres"');
      if (isClient && hasPostgres) {
        expect.fail(
          `クライアントコンポーネントから直接 DB を触っています (${relPath}) — CLAUDE.md 禁止事項`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// フェーズ16 Server Actions の 'use server' 宣言確認
// ---------------------------------------------------------------------------
describe("フェーズ16 Server Action ファイルの 'use server' 宣言", () => {
  it("src/lib/points/actions.ts が 'use server' を宣言している", () => {
    const path = join(ROOT, "src", "lib", "points", "actions.ts");
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/^['"]use server['"]/m);
  });

  it("src/lib/handover/actions.ts が 'use server' を宣言している", () => {
    const path = join(ROOT, "src", "lib", "handover", "actions.ts");
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/^['"]use server['"]/m);
  });

  it("src/lib/handover/therapist-portal-actions.ts が 'use server' を宣言している", () => {
    const path = join(ROOT, "src", "lib", "handover", "therapist-portal-actions.ts");
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/^['"]use server['"]/m);
  });

  it("src/lib/nomination/actions.ts が 'use server' を宣言している", () => {
    const path = join(ROOT, "src", "lib", "nomination", "actions.ts");
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/^['"]use server['"]/m);
  });
});

// ---------------------------------------------------------------------------
// 公開側（src/app/(public)）にフェーズ16コードが混入していないこと
// ---------------------------------------------------------------------------
const PUBLIC_DIR = join(ROOT, "src", "app", "(public)");
const publicFiles = collectFiles(PUBLIC_DIR);

describe("公開側ファイルへのフェーズ16コード混入確認", () => {
  it("公開側の .ts/.tsx ファイルが存在する（走査できている）", () => {
    expect(publicFiles.length).toBeGreaterThan(0);
  });

  it("公開側に points/handover/nomination 関連ファイルが混入していない", () => {
    const mixed = publicFiles.filter(
      (f) =>
        f.includes("point") ||
        f.includes("handover") ||
        f.includes("nomination") ||
        f.includes("ng-pair") ||
        f.includes("ng_pair"),
    );
    expect(
      mixed,
      "公開側に points/handover/nomination 関連コードが混入しています",
    ).toEqual([]);
  });

  it("公開側のファイルに直書き日本語が無い（spec 3-6・13-1）", () => {
    // CJK / ひらがな / カタカナ
    const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿]/;
    const violations: string[] = [];
    for (const file of publicFiles) {
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      if (JAPANESE_RE.test(code)) {
        violations.push(file.replace(ROOT, ""));
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// フェーズ16 新規コードに 'server-only' インポートがある（DB 層ガード）
// ---------------------------------------------------------------------------
describe("DB 層の server-only インポート確認", () => {
  const serverOnlyFiles = [
    join(ROOT, "src", "lib", "points", "queries.ts"),
    join(ROOT, "src", "lib", "handover", "queries.ts"),
  ];

  for (const filePath of serverOnlyFiles) {
    it(`server-only をインポートしている: ${filePath.replace(ROOT, "")}`, () => {
      const src = readFileSync(filePath, "utf8");
      expect(src).toMatch(/import\s+["']server-only["']/);
    });
  }
});
