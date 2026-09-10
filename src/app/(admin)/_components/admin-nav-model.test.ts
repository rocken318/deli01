import { describe, it, expect } from "vitest";
import { ADMIN_NAV_GROUPS, findActiveNavItem } from "./admin-nav-model";

describe("ADMIN_NAV_GROUPS", () => {
  it("主要グループが先頭で、4項目をピン留めする", () => {
    const primary = ADMIN_NAV_GROUPS[0];
    expect(primary?.label).toBe("主要");
    expect(primary?.items.map((i) => i.href)).toEqual([
      "/admin/orders",
      "/admin/annai",
      "/admin/dispatch-board",
      "/admin/reservations",
    ]);
  });

  it("全 href が一意（重複リンクを作らない）", () => {
    const hrefs = ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("findActiveNavItem", () => {
  it("完全一致でアクティブ項目を返す", () => {
    const item = findActiveNavItem(ADMIN_NAV_GROUPS, "/admin/annai");
    expect(item?.href).toBe("/admin/annai");
  });

  it("配下パス（前方一致 + '/'）でも親をアクティブにする", () => {
    const item = findActiveNavItem(ADMIN_NAV_GROUPS, "/admin/reservations/abc123");
    expect(item?.href).toBe("/admin/reservations");
  });

  it("最長一致を優先する（/admin/preview/home が /admin より優先）", () => {
    const item = findActiveNavItem(ADMIN_NAV_GROUPS, "/admin/preview/home");
    expect(item?.href).toBe("/admin/preview/home");
  });

  it("該当なしは null", () => {
    expect(findActiveNavItem(ADMIN_NAV_GROUPS, "/admin/does-not-exist")).toBeNull();
  });
});
