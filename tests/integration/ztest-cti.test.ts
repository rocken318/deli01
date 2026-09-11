import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  getRecentIncomingCalls,
  markCtiHandled,
  simulateIncoming,
} from "@/lib/cti/actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

/** シード済み owner（getDevSession がこれを返す） */
const OWNER_USER = "aaaaaaaa-0000-4000-8000-000000000001";

// テスト専用の電話番号（既存顧客と衝突しない番号）
const TEST_PHONE_NEW = "09099990001";
const TEST_PHONE_EXISTING = "09099990002";
const TEST_CUSTOMER_NAME = "CTIテスト顧客";

let createdCtiIds: string[] = [];
let createdCustomerIds: string[] = [];

afterAll(async () => {
  if (createdCtiIds.length > 0) {
    // id は bigint (generated always as identity) — IN 句で削除
    for (const id of createdCtiIds) {
      await sql`delete from cti_events where id = ${id}::bigint`;
    }
  }
  if (createdCustomerIds.length > 0) {
    await sql`delete from customers where id = any(${createdCustomerIds}::uuid[])`;
  }
  await sql.end({ timeout: 5 });
});

describe("simulateIncoming + getRecentIncomingCalls + markCtiHandled", () => {
  it("新規番号で模擬着信 → getRecentIncomingCalls に出る（customerId/matchedName は null）", async () => {
    const r = await simulateIncoming(TEST_PHONE_NEW);
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    createdCtiIds.push(r.data!.id);

    const list = await getRecentIncomingCalls(300);
    expect(list.ok).toBe(true);
    const found = list.data?.find((e) => e.id === r.data!.id);
    expect(found).toBeDefined();
    expect(found?.phone).toBe(TEST_PHONE_NEW);
    expect(found?.customerId).toBeNull();
    expect(found?.matchedName).toBeNull();
    expect(found?.handled).toBe(false);
    expect(found?.occurredAtISO).toBeDefined();
  });

  it("既存顧客の番号で模擬着信 → customerId/matchedName が付く", async () => {
    // 顧客を作っておく
    const custRows = await sql<{ id: string }[]>`
      insert into customers (phone, name)
      values (${TEST_PHONE_EXISTING}, ${TEST_CUSTOMER_NAME})
      on conflict (phone) do update set name = excluded.name, updated_at = now()
      returning id
    `;
    const customerId = custRows[0]?.id;
    expect(customerId).toBeDefined();
    createdCustomerIds.push(customerId!);

    const r = await simulateIncoming(TEST_PHONE_EXISTING);
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    createdCtiIds.push(r.data!.id);

    const list = await getRecentIncomingCalls(300);
    expect(list.ok).toBe(true);
    const found = list.data?.find((e) => e.id === r.data!.id);
    expect(found).toBeDefined();
    expect(found?.customerId).toBe(customerId);
    expect(found?.matchedName).toBe(TEST_CUSTOMER_NAME);
  });

  it("markCtiHandled → handled=true になる（set-once）", async () => {
    // 新しい着信を作る
    const r = await simulateIncoming(TEST_PHONE_NEW);
    expect(r.ok).toBe(true);
    const id = r.data!.id;
    createdCtiIds.push(id);

    // 未対応確認
    const before = await getRecentIncomingCalls(300);
    const entry = before.data?.find((e) => e.id === id);
    expect(entry?.handled).toBe(false);

    // 対応済み
    const mark = await markCtiHandled(id);
    expect(mark.ok).toBe(true);

    // 対応済み確認
    const after = await getRecentIncomingCalls(300);
    const updated = after.data?.find((e) => e.id === id);
    expect(updated?.handled).toBe(true);

    // 二重 mark は no-op（ok=true で戻る）
    const again = await markCtiHandled(id);
    expect(again.ok).toBe(true);
  });

  it("不正な電話番号は拒否される", async () => {
    const r = await simulateIncoming("12345");
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("getRecentIncomingCalls は新しい順・上限20件", async () => {
    const list = await getRecentIncomingCalls(300);
    expect(list.ok).toBe(true);
    const data = list.data ?? [];
    expect(data.length).toBeLessThanOrEqual(20);

    // 新しい順の検証（occurred_at が降順）
    for (let i = 1; i < data.length; i++) {
      const prev = new Date(data[i - 1]!.occurredAtISO).getTime();
      const curr = new Date(data[i]!.occurredAtISO).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });
});
