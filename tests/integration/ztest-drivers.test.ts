import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  listDrivers,
  createDriver,
  updateDriver,
  deleteDriver,
} from "@/lib/drivers/actions";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

const ids: string[] = [];

afterAll(async () => {
  if (ids.length > 0) await sql`delete from drivers where id = any(${ids}::uuid[])`;
  await sql.end({ timeout: 5 });
});

describe("drivers CRUD（owner session = ADMIN_DEV_SESSION）", () => {
  it("作成できる（色hex含む）", async () => {
    const r = await createDriver({
      name: "畑山",
      phone: "08055580414",
      ngNote: "土曜固定。",
      vehicleNumber: "6417",
      vehicleModel: "ステップワゴン",
      vehicleColorHex: "#2B2B2B",
      vehicleColorName: "黒",
      vehicleNote: "自動ドア",
      sortOrder: 1,
      isActive: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    ids.push(r.data!.id);
  });

  it("一覧に出る", async () => {
    const r = await listDrivers();
    expect(r.ok).toBe(true);
    const found = r.data?.find((d) => d.name === "畑山");
    expect(found?.vehicleColorHex).toBe("#2B2B2B");
    expect(found?.vehicleColorName).toBe("黒");
  });

  it("不正な色hexは拒否", async () => {
    const r = await createDriver({ name: "X", vehicleColorHex: "black" });
    expect(r.ok).toBe(false);
  });

  it("更新できる", async () => {
    const r = await updateDriver({ id: ids[0]!, vehicleColorName: "つや黒", isActive: false });
    expect(r.ok).toBe(true);
    const list = await listDrivers();
    const found = list.data?.find((d) => d.id === ids[0]);
    expect(found?.vehicleColorName).toBe("つや黒");
    expect(found?.isActive).toBe(false);
  });

  it("削除できる", async () => {
    const id = ids.pop()!;
    const r = await deleteDriver(id);
    expect(r.ok).toBe(true);
    const list = await listDrivers();
    expect(list.data?.find((d) => d.id === id)).toBeUndefined();
  });
});

describe("drivers RLS", () => {
  it("reception は drivers を INSERT できない", async () => {
    await expect(
      withUser(sql, receptionSession, async (tx) => {
        return tx`insert into drivers (name) values ('X') returning id`;
      }),
    ).rejects.toThrow();
  });
});
