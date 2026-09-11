import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  listOptionsAdmin,
  createOption,
  updateOption,
  deleteOption,
} from "@/lib/options/actions";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

const ids: string[] = [];

afterAll(async () => {
  if (ids.length > 0) await sql`delete from options where id = any(${ids}::uuid[])`;
  await sql.end({ timeout: 5 });
});

describe("options CRUD（owner session = ADMIN_DEV_SESSION）", () => {
  it("作成できる（rate バック）", async () => {
    const r = await createOption({
      name: `テストオプション_${Date.now()}`,
      description: "テスト用の説明文",
      price: 3000,
      durationMin: 20,
      backType: "rate",
      backValue: 30,
      isPublic: true,
      isActive: true,
      sortOrder: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    ids.push(r.data!.id);
  });

  it("一覧に出る", async () => {
    const r = await listOptionsAdmin();
    expect(r.ok).toBe(true);
    const found = r.data?.find((o) => o.id === ids[0]);
    expect(found).toBeDefined();
    expect(found?.price).toBe(3000);
    expect(found?.backType).toBe("rate");
    expect(found?.backValue).toBe(30);
    expect(found?.durationMin).toBe(20);
    expect(found?.isPublic).toBe(true);
    expect(found?.isActive).toBe(true);
  });

  it("rate > 100 は拒否", async () => {
    const r = await createOption({
      name: `無効オプション_${Date.now()}`,
      price: 1000,
      durationMin: 0,
      backType: "rate",
      backValue: 101,
      isPublic: false,
      isActive: true,
      sortOrder: 0,
    });
    expect(r.ok).toBe(false);
  });

  it("name 重複は拒否（日本語メッセージ）", async () => {
    const list = await listOptionsAdmin();
    const existing = list.data?.find((o) => o.id === ids[0]);
    if (!existing) return;
    const r = await createOption({
      name: existing.name,
      price: 1000,
      durationMin: 0,
      backType: "fixed",
      backValue: 500,
      isPublic: false,
      isActive: true,
      sortOrder: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("同名のオプション");
  });

  it("更新できる", async () => {
    const r = await updateOption({ id: ids[0]!, price: 5000, isActive: false });
    expect(r.ok).toBe(true);
    const list = await listOptionsAdmin();
    const found = list.data?.find((o) => o.id === ids[0]);
    expect(found?.price).toBe(5000);
    expect(found?.isActive).toBe(false);
  });

  it("削除できる", async () => {
    const id = ids.pop()!;
    const r = await deleteOption(id);
    expect(r.ok).toBe(true);
    const list = await listOptionsAdmin();
    expect(list.data?.find((o) => o.id === id)).toBeUndefined();
  });
});

describe("options RLS", () => {
  it("reception はオプションを INSERT できない", async () => {
    await expect(
      withUser(sql, receptionSession, async (tx) => {
        return tx`insert into options (name, price, duration_min, back_type, back_value) values ('rls_test_${randomUUID()}', 1000, 0, 'rate', 10) returning id`;
      }),
    ).rejects.toThrow();
  });
});
