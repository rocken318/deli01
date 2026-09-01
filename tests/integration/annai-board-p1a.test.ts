import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { listAnnaiBoardCore } from "@/lib/annai/queries";
import { buildBoard } from "@/domain/annai";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });
const OWNER: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "owner" };

afterAll(async () => {
  await sql.end();
});

describe("annai board (実Postgres・seed-demo 当日タイムライン前提)", () => {
  it("yuna の当日 done×2 / upcoming×2 が集約される", async () => {
    const nowMs = Date.now();
    const rows = await withUser(sql, OWNER, (tx) => listAnnaiBoardCore(tx, nowMs));
    const yuna = rows.find((r) => r.slug === "yuna");
    expect(yuna).toBeTruthy();
    expect(yuna!.done.length).toBeGreaterThanOrEqual(2);
    expect(yuna!.upcoming.length).toBeGreaterThanOrEqual(2);
    const { active } = buildBoard(rows, nowMs);
    expect(Array.isArray(active)).toBe(true);
  });

  it("行は名前・slug・状態を持つ", async () => {
    const rows = await withUser(sql, OWNER, (tx) => listAnnaiBoardCore(tx, Date.now()));
    for (const r of rows) {
      expect(typeof r.slug).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(["off", "working", "done"]).toContain(r.attendanceState);
    }
  });
});
