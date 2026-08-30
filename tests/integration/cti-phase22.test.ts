import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { POST } from "@/app/api/cti/incoming/route";

/**
 * フェーズ22 CTI 受け口（下地）の統合テスト（実 Postgres）。
 * 完了条件「テスト着信で顧客情報がポップする」= webhook が電話番号で顧客を引き当て、
 * ポップ用ペイロードを返し cti_events に記録する。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 2, onnotice: () => {} });

const PHONE = "0906666" + String(Date.now()).slice(-4);
let customerId = "";

function callWebhook(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/cti/incoming", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  const rows = await sql<{ id: string }[]>`
    insert into customers (phone, name) values (${PHONE}, 'CTIテスト花子')
    on conflict (phone) do update set name = excluded.name
    returning id
  `;
  customerId = rows[0]!.id;
});

afterAll(async () => {
  await sql`delete from cti_events where phone = ${PHONE} or phone = '0900000000'`;
  await sql`delete from customers where id = ${customerId}::uuid`;
  await sql.end({ timeout: 5 });
});

describe("CTI incoming webhook（下地・受入 L1074）", () => {
  it("既存顧客の着信で顧客情報がポップし cti_events に記録される", async () => {
    const res = await callWebhook({ phone: PHONE });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      matched: boolean;
      customer: { id: string; name: string } | null;
    };
    expect(json.ok).toBe(true);
    expect(json.matched).toBe(true);
    expect(json.customer?.name).toBe("CTIテスト花子");

    const events = await sql<{ n: number }[]>`
      select count(*)::int as n from cti_events
      where phone = ${PHONE} and customer_id = ${customerId}::uuid
    `;
    expect(events[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it("未登録番号の着信は matched=false だが記録は残る（新規識別）", async () => {
    const res = await callWebhook({ phone: "0900000000" });
    const json = (await res.json()) as { ok: boolean; matched: boolean };
    expect(json.ok).toBe(true);
    expect(json.matched).toBe(false);
    const events = await sql<{ n: number }[]>`
      select count(*)::int as n from cti_events where phone = '0900000000'
    `;
    expect(events[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it("電話番号の形式が不正なら 400", async () => {
    const res = await callWebhook({ phone: "abc" });
    expect(res.status).toBe(400);
  });
});
