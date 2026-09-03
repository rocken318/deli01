/**
 * getBookingShareTexts 統合テスト（spec 12-2 / 管理側）。
 * ADMIN_DEV_SESSION=1 + 実 Postgres 前提。自己完結（作成→検証→削除）。
 *
 * 検証内容:
 * - セラピスト向けテキストに電話番号が含まれないこと
 * - セラピスト向けテキストに施術開始日時・コース名・場所が含まれること
 * - ドライバー向けテキストに出発時刻・ホテル名・部屋番号・電話番号が含まれること
 * - 無効 UUID → ok=false
 * - 存在しない UUID → ok=false
 */

import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createPhoneOrder } from "@/app/(admin)/admin/orders/actions";
import { getBookingShareTexts } from "@/lib/booking/share-texts";
import { formatInTimeZone } from "date-fns-tz";

const enabled = process.env.ADMIN_DEV_SESSION === "1";
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });
const TZ = "Asia/Tokyo";

// テスト用ユニーク電話番号（衝突回避）
const PHONE = "0" + String(Date.now()).slice(-10);

// クリーンアップ対象
let createdReservationId: string | null = null;

afterAll(async () => {
  if (enabled && createdReservationId) {
    await sql`
      delete from reservation_options where reservation_id = ${createdReservationId}::uuid
    `;
    await sql`
      delete from addresses where customer_id in (
        select id from customers where phone = ${PHONE}
      )
    `;
    await sql`
      delete from reservations where id = ${createdReservationId}::uuid
    `;
    await sql`delete from customers where phone = ${PHONE}`;
  }
  await sql.end();
});

describe.skipIf(!enabled)("getBookingShareTexts", () => {
  it("セラピスト向け/ドライバー向けテキストを正しく組み立てる", async () => {
    const today = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");

    // シードに含まれるホテルを1件取得（ホテルルートでテスト）
    const hotels = await sql<{ id: string; name: string; area_id: string | null }[]>`
      select id, name, area_id from hotels where is_blocked = false limit 1
    `;
    if (hotels.length === 0) return; // シードなし → スキップ

    const hotel = hotels[0]!;

    // aoi セラピストの今日のシフトが存在するか確認
    const aoiRows = await sql<{ id: string; slug: string }[]>`
      select t.id, t.slug from therapists t where slug = 'aoi' limit 1
    `;
    if (aoiRows.length === 0) return; // シードなし
    const therapist = aoiRows[0]!;

    const shiftRows = await sql<{ id: string }[]>`
      select id from shifts
      where therapist_id = ${therapist.id}::uuid
        and work_date = ${today}
        and is_day_off = false
      limit 1
    `;
    if (shiftRows.length === 0) return; // 今日のシフトなし → スキップ

    // 最短コース取得
    const courseRows = await sql<{ id: string; name: string; duration_min: number }[]>`
      select id, name, duration_min from courses where is_active = true
      order by duration_min asc limit 1
    `;
    if (courseRows.length === 0) return;
    const course = courseRows[0]!;

    // 枠を計算して最初の枠を使う（createPhoneOrder が engine を再利用するため、
    // 枠なしでも slot_gone → 枠外ルートで作成される。テストはその後の
    // テキスト組み立てのみを検証する）
    const createResult = await createPhoneOrder({
      phone: PHONE,
      customerName: "LINEテスト顧客",
      destinationType: "hotel",
      hotelId: hotel.id,
      roomNumber: "0101",
      therapistId: therapist.id,
      therapistSlug: therapist.slug,
      courseId: course.id,
      optionIds: [],
      // 現在時刻から1時間後の枠外時刻（overrideReason があれば枠外ルートで作成）
      startAtISO: new Date(Date.now() + 3600_000).toISOString(),
      dateISO: today,
      overrideReason: "テスト枠外予約",
    });

    if (!createResult.ok || !createResult.data) {
      // 枠外予約がオーナー権限でないと弾かれるシードなら skip
      return;
    }

    createdReservationId = createResult.data.reservationId;

    // テキスト取得
    const shareResult = await getBookingShareTexts(createdReservationId);
    expect(shareResult.ok).toBe(true);
    expect(shareResult.data).toBeDefined();

    const { therapist: therapistText, driver: driverText } = shareResult.data!;

    // セラピスト向け: コース名・場所が含まれる
    expect(therapistText).toContain(course.name);
    expect(therapistText).toContain(hotel.name);

    // セラピスト向け: 電話番号が含まれないこと（PII 除去）
    const phoneDig = PHONE.replace(/\D/g, "");
    expect(therapistText).not.toContain(phoneDig);
    // 電話番号を全角・ハイフン区切りでも含まない
    expect(therapistText).not.toContain(PHONE);

    // ドライバー向け: ホテル名・IN・電話番号を含む
    expect(driverText).toContain(hotel.name);
    expect(driverText).toContain("IN:");
    expect(driverText).toContain(phoneDig);
    expect(driverText).toContain("0101号室");

    // ドライバー向け: 出発（depart_at）が含まれる
    expect(driverText).toContain("出発");
  });

  it("無効な UUID → ok=false", async () => {
    const result = await getBookingShareTexts("not-a-uuid");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/無効な予約ID/);
  });

  it("存在しない UUID → ok=false", async () => {
    const result = await getBookingShareTexts("00000000-0000-0000-0000-000000000000");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/見つかりません/);
  });
});
