import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
import { listHotelsLookup } from "@/lib/hotels/hotel-lookup-actions";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });
afterAll(async () => { await sql.end({ timeout: 5 }); });

describe("listHotelsLookup", () => {
  it("seed のホテルを参照でき、record が付く", async () => {
    const r = await listHotelsLookup();
    expect(r.ok).toBe(true);
    expect((r.data?.length ?? 0)).toBeGreaterThan(0);
    const any = r.data![0]!;
    expect(["ok","caution","blocked"]).toContain(any.record);
    expect(typeof any.name).toBe("string");
    expect("cardKeyRequired" in any).toBe(true);
  });
});
