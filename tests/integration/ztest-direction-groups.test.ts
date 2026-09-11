import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

// revalidatePath はリクエストコンテキスト外だと動かないため no-op 化
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  listDirectionGroups,
  createDirectionGroup,
  updateDirectionGroup,
  deleteDirectionGroup,
} from "@/lib/dispatch-board/direction-actions";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

/**
 * direction_groups 統合テスト（0037 / 設計 4.5 方面グループ）。
 *
 * 検証内容:
 * 1. CRUD（owner session = ADMIN_DEV_SESSION）
 * 2. RLS（reception は select 可・write 不可）
 *
 * 前提: pnpm db:migrate 適用済み（0037_direction_groups.sql）。db:reset/seed はしない。
 * 命名: ztest- プレフィックスで他テストの後に実行。自己完結（afterAll でクリーンアップ）。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });

// seed 固定 UUID
const RECEPTION_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const receptionSession: Session = { userId: RECEPTION_USER, role: "reception" };

const createdIds: string[] = [];

afterAll(async () => {
  if (createdIds.length > 0) {
    await sql`delete from direction_groups where id = any(${createdIds}::uuid[])`;
  }
  await sql.end({ timeout: 5 });
});

// =====================================================================
// 1. CRUD（owner session = ADMIN_DEV_SESSION）
// =====================================================================
describe("direction_groups: CRUD（owner session = ADMIN_DEV_SESSION）", () => {
  it("方面グループを作成できる", async () => {
    const r = await createDirectionGroup({
      name: "泉区・松森方面",
      sortOrder: 1,
      isActive: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBeDefined();
    createdIds.push(r.data!.id);
  });

  it("listDirectionGroups で作成したグループが取得できる", async () => {
    const r = await listDirectionGroups();
    expect(r.ok).toBe(true);
    const found = r.data?.find((g) => g.name === "泉区・松森方面");
    expect(found).toBeDefined();
    expect(found?.sortOrder).toBe(1);
    expect(found?.isActive).toBe(true);
  });

  it("方面グループを更新できる", async () => {
    const id = createdIds[0]!;
    const r = await updateDirectionGroup({ id, name: "泉区・松森・七北田方面", isActive: false });
    expect(r.ok).toBe(true);

    const list = await listDirectionGroups();
    const found = list.data?.find((g) => g.id === id);
    expect(found?.name).toBe("泉区・松森・七北田方面");
    expect(found?.isActive).toBe(false);
  });

  it("方面グループを削除できる", async () => {
    const id = createdIds.pop()!;
    const r = await deleteDirectionGroup(id);
    expect(r.ok).toBe(true);

    const list = await listDirectionGroups();
    const found = list.data?.find((g) => g.id === id);
    expect(found).toBeUndefined();
  });
});

// =====================================================================
// 2. RLS（reception は select 可・write 不可）
// =====================================================================
describe("direction_groups: RLS", () => {
  let testGroupId: string;

  beforeAll(async () => {
    const r = await createDirectionGroup({ name: "RLSテスト方面", sortOrder: 99, isActive: true });
    expect(r.ok).toBe(true);
    testGroupId = r.data!.id;
    createdIds.push(testGroupId);
  });

  it("reception セッションは direction_groups を SELECT できる", async () => {
    const rows = await withUser(sql, receptionSession, async (tx) => {
      return tx<{ id: string }[]>`
        select id from direction_groups where id = ${testGroupId}::uuid
      `;
    });
    expect(rows.length).toBe(1);
  });

  it("reception セッションは direction_groups を DELETE できない（RLS 拒否: 0行）", async () => {
    const result = await withUser(sql, receptionSession, async (tx) => {
      return tx`delete from direction_groups where id = ${testGroupId}::uuid returning id`;
    });
    // 0 件 = RLS がブロック済み。まだテーブルに残っていること
    expect(result).toHaveLength(0);
    const rows = await sql`select id from direction_groups where id = ${testGroupId}::uuid`;
    expect(rows).toHaveLength(1);
  });
});
