import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  searchCustomers,
  upsertCustomer,
  getCustomerDetail,
} from "@/lib/customers/actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

// 衝突回避: 080 + Date.now() 末尾
const suffix = Date.now().toString().slice(-6);
const TEST_PHONE = `080${suffix}1234`.slice(0, 11);
const TEST_PHONE2 = `090${suffix}5678`.slice(0, 11);

const createdIds: string[] = [];

afterAll(async () => {
  if (createdIds.length > 0) {
    await sql`delete from customers where id = any(${createdIds}::uuid[])`;
  }
  await sql.end({ timeout: 5 });
});

describe("customers: upsertCustomer + searchCustomers + getCustomerDetail", () => {
  it("新規顧客を作成できる", async () => {
    const r = await upsertCustomer({
      phone: TEST_PHONE,
      name: "統合テスト太郎",
      nameKana: "トウゴウテストタロウ",
      note: "テストメモ",
    });
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    createdIds.push(r.data!.id);
  });

  it("電話番号で検索してヒットする", async () => {
    const r = await searchCustomers(TEST_PHONE.slice(0, 6));
    expect(r.ok).toBe(true);
    const found = r.data?.find((c) => c.phone === TEST_PHONE);
    expect(found).toBeDefined();
    expect(found?.name).toBe("統合テスト太郎");
    expect(found?.nameKana).toBe("トウゴウテストタロウ");
  });

  it("名前で検索してヒットする", async () => {
    const r = await searchCustomers("統合テスト");
    expect(r.ok).toBe(true);
    const found = r.data?.find((c) => c.phone === TEST_PHONE);
    expect(found).toBeDefined();
    expect(found?.name).toBe("統合テスト太郎");
  });

  it("getCustomerDetail で profile と pointsBalance(0) と空の recentReservations が返る", async () => {
    const id = createdIds[0]!;
    const r = await getCustomerDetail(id);
    expect(r.ok).toBe(true);
    expect(r.data?.profile.phone).toBe(TEST_PHONE);
    expect(r.data?.profile.name).toBe("統合テスト太郎");
    expect(r.data?.profile.nameKana).toBe("トウゴウテストタロウ");
    expect(r.data?.profile.note).toBe("テストメモ");
    expect(r.data?.pointsBalance).toBe(0);
    expect(r.data?.recentReservations).toEqual([]);
    expect(r.data?.ngTherapists).toEqual([]);
    expect(r.data?.handoverNotes).toEqual([]);
  });

  it("upsertCustomer で名前を更新できる（id 指定）", async () => {
    const id = createdIds[0]!;
    const r = await upsertCustomer({
      id,
      phone: TEST_PHONE,
      name: "統合テスト花子",
    });
    expect(r.ok).toBe(true);
    const detail = await getCustomerDetail(id);
    expect(detail.data?.profile.name).toBe("統合テスト花子");
    // note は null になる（更新で省略 → null 上書き）
    expect(detail.data?.profile.nameKana).toBeNull();
  });

  it("同じ電話番号で新規作成すると日本語エラーになる", async () => {
    const r = await upsertCustomer({
      phone: TEST_PHONE,
      name: "重複テスト",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("同じ電話番号");
  });

  it("空 query で最近の顧客一覧が返る", async () => {
    const r = await searchCustomers("");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it("2人目の顧客を作成できる（電話番号 suffix 違い）", async () => {
    const r = await upsertCustomer({
      phone: TEST_PHONE2,
      name: "統合テスト次郎",
    });
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    createdIds.push(r.data!.id);
  });

  it("不正な電話番号は Zod で弾かれる", async () => {
    const r = await upsertCustomer({
      phone: "12345",
      name: "バリデーションテスト",
    });
    expect(r.ok).toBe(false);
  });

  it("無効な customerId は getCustomerDetail でエラー", async () => {
    const r = await getCustomerDetail("not-a-uuid");
    expect(r.ok).toBe(false);
  });
});
