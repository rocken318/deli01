/**
 * "server-only" のテスト用モック。
 *
 * Next.js の "server-only" パッケージは Node / vitest 環境で throw するため、
 * vitest.config.ts の resolve.alias で本ファイルに差し替える。
 * これにより server-only を import している lib を統合テストから呼べる。
 */
// 意図的に何もしない（空モジュール）
export {};
