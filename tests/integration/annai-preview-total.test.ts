import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { previewOrderTotal } from "@/app/(admin)/admin/orders/preview-actions";

/**
 * previewOrderTotal（案内表インライン予約の総額プレビュー）。
 * 前提: ADMIN_DEV_SESSION=1（getDevSession が owner を返す / 他の server action 統合テストと同条件）。
 */
const enabled = process.env.ADMIN_DEV_SESSION === "1";
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

afterAll(async () => {
  await sql.end();
});

describe("previewOrderTotal (実Postgres)", () => {
  it("コースの total が course price 以上・feeBreakdown 経由で算出される", async () => {
    if (!enabled) return; // ADMIN_DEV_SESSION 無効環境ではスキップ
    const [course] = await sql<{ id: string; price: number }[]>`
      select id, price from courses order by duration_min limit 1
    `;
    const r = await previewOrderTotal({
      courseId: course!.id,
      optionIds: [],
      startAtISO: new Date().toISOString(),
      travelInMode: "car",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.totalAmount).toBeGreaterThanOrEqual(course!.price);
    }
  });

  it("オプションを足すと total が増える", async () => {
    if (!enabled) return;
    const [course] = await sql<{ id: string }[]>`select id from courses order by duration_min limit 1`;
    const opts = await sql<{ id: string; price: number }[]>`select id, price from options where price > 0 limit 1`;
    if (opts.length === 0) return;
    const base = await previewOrderTotal({ courseId: course!.id, optionIds: [], startAtISO: new Date().toISOString(), travelInMode: "car" });
    const withOpt = await previewOrderTotal({ courseId: course!.id, optionIds: [opts[0]!.id], startAtISO: new Date().toISOString(), travelInMode: "car" });
    expect(base.ok && withOpt.ok).toBe(true);
    if (base.ok && withOpt.ok) {
      expect(withOpt.data.totalAmount).toBe(base.data.totalAmount + opts[0]!.price);
    }
  });
});
