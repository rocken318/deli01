/**
 * ホテル管理 Server Actions の統合テスト（実 Postgres）。
 *
 * ADMIN_DEV_SESSION=1 が有効な環境で getDevSession() が owner セッションを返すことを前提にする。
 * テスト用ホテルはテスト内で作成・削除する（db:reset/db:seed はしない）。
 * 0026: card_key_required / guest_charge_note / access_note / maps_url の保存・取得を追加。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

// revalidatePath はリクエストコンテキスト外だと動かないため no-op 化
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import {
  listHotelsAdmin,
  listBookableHotels,
  createHotel,
  updateHotel,
  deleteHotel,
} from "@/lib/hotels/hotel-admin-actions";

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const rawSql = postgres(url, { max: 1, onnotice: () => {} });

const TEST_PREFIX = "ztest_hotel_";

// テスト用ホテルを後片付けする
afterAll(async () => {
  await rawSql`delete from hotels where name like ${TEST_PREFIX + "%"}`;
  await rawSql.end({ timeout: 5 });
});

describe("createHotel", () => {
  it("正常作成: id が返る", async () => {
    const result = await createHotel({
      name: TEST_PREFIX + "グランドホテル",
      extraMinutes: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.data?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("name unique 違反 → 同名のホテルが既にあります", async () => {
    const name = TEST_PREFIX + "同名テスト";
    await createHotel({ name, extraMinutes: 0 });
    const dup = await createHotel({ name, extraMinutes: 0 });
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("同名のホテルが既にあります");
  });

  it("name が空文字 → バリデーションエラー", async () => {
    const result = await createHotel({ name: "", extraMinutes: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("extraMinutes が負 → バリデーションエラー", async () => {
    const result = await createHotel({ name: TEST_PREFIX + "negative", extraMinutes: -1 });
    expect(result.ok).toBe(false);
  });

  it("0026: card_key_required=true で保存・取得できる", async () => {
    const result = await createHotel({
      name: TEST_PREFIX + "カードキーテスト",
      extraMinutes: 0,
      cardKeyRequired: true,
      guestChargeNote: "ゲストチャージ2000円",
      accessNote: "2024/3に断られた",
      mapsUrl: "https://maps.google.com/?q=test",
    });
    expect(result.ok).toBe(true);
    const list = await listHotelsAdmin();
    const row = list.data?.find((h) => h.id === result.data?.id);
    expect(row?.cardKeyRequired).toBe(true);
    expect(row?.guestChargeNote).toBe("ゲストチャージ2000円");
    expect(row?.accessNote).toBe("2024/3に断られた");
    expect(row?.mapsUrl).toBe("https://maps.google.com/?q=test");
  });

  it("0026: card_key_required デフォルトは false", async () => {
    const result = await createHotel({
      name: TEST_PREFIX + "デフォルトテスト",
      extraMinutes: 0,
    });
    expect(result.ok).toBe(true);
    const list = await listHotelsAdmin();
    const row = list.data?.find((h) => h.id === result.data?.id);
    expect(row?.cardKeyRequired).toBe(false);
    expect(row?.guestChargeNote).toBeNull();
    expect(row?.accessNote).toBeNull();
    expect(row?.mapsUrl).toBeNull();
  });
});

describe("updateHotel", () => {
  let hotelId: string;

  beforeAll(async () => {
    const r = await createHotel({ name: TEST_PREFIX + "更新テスト", extraMinutes: 0 });
    expect(r.ok).toBe(true);
    hotelId = r.data!.id;
  });

  it("entryNote を更新できる", async () => {
    const r = await updateHotel({ id: hotelId, entryNote: "フロント呼び出し" });
    expect(r.ok).toBe(true);
    const list = await listHotelsAdmin();
    const row = list.data?.find((h) => h.id === hotelId);
    expect(row?.entryNote).toBe("フロント呼び出し");
  });

  it("isBlocked=true で受け入れ停止できる", async () => {
    const r = await updateHotel({ id: hotelId, isBlocked: true });
    expect(r.ok).toBe(true);
    const list = await listHotelsAdmin();
    const row = list.data?.find((h) => h.id === hotelId);
    expect(row?.isBlocked).toBe(true);
  });

  it("0026: card_key_required / guest_charge_note / access_note / maps_url を更新できる", async () => {
    const r = await updateHotel({
      id: hotelId,
      cardKeyRequired: true,
      guestChargeNote: "同伴不可",
      accessNote: "裏口から入る",
      mapsUrl: "https://maps.google.com/?q=updated",
    });
    expect(r.ok).toBe(true);
    const list = await listHotelsAdmin();
    const row = list.data?.find((h) => h.id === hotelId);
    expect(row?.cardKeyRequired).toBe(true);
    expect(row?.guestChargeNote).toBe("同伴不可");
    expect(row?.accessNote).toBe("裏口から入る");
    expect(row?.mapsUrl).toBe("https://maps.google.com/?q=updated");
  });

  it("0026: mapsUrl を null にクリアできる", async () => {
    const r = await updateHotel({ id: hotelId, mapsUrl: null });
    expect(r.ok).toBe(true);
    const list = await listHotelsAdmin();
    const row = list.data?.find((h) => h.id === hotelId);
    expect(row?.mapsUrl).toBeNull();
  });
});

describe("listHotelsAdmin", () => {
  it("結果が返る（blocked 含む）", async () => {
    const r = await listHotelsAdmin();
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it("0026: 返り値に cardKeyRequired / guestChargeNote / accessNote / mapsUrl が含まれる", async () => {
    const r = await listHotelsAdmin();
    expect(r.ok).toBe(true);
    if (r.data && r.data.length > 0) {
      const row = r.data[0]!;
      expect(typeof row.cardKeyRequired).toBe("boolean");
      expect(row.guestChargeNote === null || typeof row.guestChargeNote === "string").toBe(true);
      expect(row.accessNote === null || typeof row.accessNote === "string").toBe(true);
      expect(row.mapsUrl === null || typeof row.mapsUrl === "string").toBe(true);
    }
  });
});

describe("listBookableHotels", () => {
  it("is_blocked=false のホテルだけ含む", async () => {
    // 停止中のホテルを作って検証
    const name = TEST_PREFIX + "停止テスト";
    const cr = await createHotel({ name, extraMinutes: 0 });
    expect(cr.ok).toBe(true);
    await updateHotel({ id: cr.data!.id, isBlocked: true });

    const r = await listBookableHotels();
    expect(r.ok).toBe(true);
    const found = r.data?.find((h) => h.name === name);
    expect(found).toBeUndefined();
  });
});

describe("deleteHotel", () => {
  it("存在するホテルを削除できる", async () => {
    const cr = await createHotel({ name: TEST_PREFIX + "削除テスト", extraMinutes: 0 });
    expect(cr.ok).toBe(true);
    const dr = await deleteHotel(cr.data!.id);
    expect(dr.ok).toBe(true);

    const list = await listHotelsAdmin();
    expect(list.data?.find((h) => h.id === cr.data!.id)).toBeUndefined();
  });

  it("不正 UUID → バリデーションエラー", async () => {
    const r = await deleteHotel("not-a-uuid");
    expect(r.ok).toBe(false);
  });
});
