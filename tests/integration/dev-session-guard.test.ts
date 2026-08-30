import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devStubEnabled } from "@/lib/cms/dev-session";

/**
 * R1 ガード（reviewer 指摘）: 本番 Vercel（VERCEL_ENV=production）では
 * ADMIN_DEV_SESSION=1 でも開発スタブ認証を拒否する。
 * 前提: テスト環境は .env の ADMIN_DEV_SESSION=1（vitest.config が読み込む）。
 * env.adminDevSession は import 時に固定されるため、ここでは VERCEL_ENV を切り替えて検証する。
 */
describe("devStubEnabled（本番デプロイガード）", () => {
  const original = process.env.VERCEL_ENV;

  beforeEach(() => {
    // このスイートは ADMIN_DEV_SESSION=1 の前提でのみ意味を持つ
    if (process.env.ADMIN_DEV_SESSION !== "1") return;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = original;
  });

  it("VERCEL_ENV 未設定（ローカル/CI）ではスタブ有効", () => {
    if (process.env.ADMIN_DEV_SESSION !== "1") return;
    delete process.env.VERCEL_ENV;
    expect(devStubEnabled()).toBe(true);
  });

  it("VERCEL_ENV=preview ではスタブ有効", () => {
    if (process.env.ADMIN_DEV_SESSION !== "1") return;
    process.env.VERCEL_ENV = "preview";
    expect(devStubEnabled()).toBe(true);
  });

  it("VERCEL_ENV=production ではスタブ拒否", () => {
    if (process.env.ADMIN_DEV_SESSION !== "1") return;
    process.env.VERCEL_ENV = "production";
    expect(devStubEnabled()).toBe(false);
  });
});
