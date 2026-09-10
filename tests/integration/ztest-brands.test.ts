import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listBrandsCore } from "@/lib/brands/queries";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

/**
 * brands 統合テスト（0030 / 設計 3章・4.1）。
 * 前提: pnpm db:migrate 適用済み（0030_brands.sql）。db:reset/seed はしない。
 * RLS はロールで判定するため userId は任意の有効な UUID でよい。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

// seed 固定 UUID（ztest-dispatch-ops.test.ts に倣う）
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const ownerSession: Session = { userId: RECEPTION_USER, role: "owner" };
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("listBrandsCore", () => {
  it("既定ブランド『王様の休日』を返す", async () => {
    const brands = await listBrandsCore(sql, ownerSession);
    const king = brands.find((b) => b.name === "王様の休日");
    expect(king).toBeDefined();
    expect(king?.shortName).toBe("王様");
    expect(king?.isActive).toBe(true);
  });

  it("reception でも参照できる（RLS 参照許可）", async () => {
    const brands = await listBrandsCore(sql, receptionSession);
    expect(brands.some((b) => b.name === "王様の休日")).toBe(true);
  });

  it("reception は brands を INSERT できない（RLS 書込拒否）", async () => {
    await expect(
      withUser(sql, receptionSession, async (tx) => {
        return tx`insert into brands (name, short_name) values ('X', 'X') returning id`;
      }),
    ).rejects.toThrow();
  });
});
