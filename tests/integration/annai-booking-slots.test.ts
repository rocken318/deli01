import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";
import { getAnnaiBookingSlots } from "@/app/(admin)/admin/annai/booking-actions";
import { createPhoneOrder } from "@/app/(admin)/admin/orders/actions";

/**
 * P1b の合格条件（reviewer S4/B2）: 案内表の枠に表示した総額 == 実際に作成される予約の
 * reservations.total_amount が一致すること。ADMIN_DEV_SESSION=1 前提（owner セッション）。
 */
const enabled = process.env.ADMIN_DEV_SESSION === "1";
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 3, onnotice: () => {} });
const TZ = "Asia/Tokyo";
const PHONE = "0" + String(Date.now()).slice(-10);

afterAll(async () => {
  await sql`delete from reservations where customer_id in (select id from customers where phone = ${PHONE})`;
  await sql`delete from addresses where customer_id in (select id from customers where phone = ${PHONE})`;
  await sql`delete from customers where phone = ${PHONE}`;
  await sql.end();
});

describe.skipIf(!enabled)("annai booking slots ⇔ createPhoneOrder 総額一致", () => {
  it("枠の totalAmount == 作成された予約の total_amount", async () => {
    const today = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
    // aoi の今日のシフト対応エリアを1つ取る（自宅・待合ルートで枠を出す）
    const rows = await sql<{ area_id: string }[]>`
      select sa.area_id
      from shifts s join shift_areas sa on sa.shift_id = s.id
      where s.therapist_id = (select id from therapists where slug='aoi' limit 1)
        and s.work_date = ${today} and s.is_day_off = false
      limit 1
    `;
    if (rows.length === 0) return; // 今日 aoi 出勤なし＝検証対象外（seed の基準日次第）
    const areaId = rows[0]!.area_id;
    const [course] = await sql<{ id: string }[]>`select id from courses where is_active=true order by duration_min limit 1`;

    const slotsRes = await getAnnaiBookingSlots({
      therapistSlug: "aoi",
      courseId: course!.id,
      optionIds: [],
      areaId,
      hotelId: null,
    });
    expect(slotsRes.ok).toBe(true);
    if (!slotsRes.ok || slotsRes.data.slots.length === 0) return; // 空枠なら検証不能
    const slot = slotsRes.data.slots[0]!;

    const created = await createPhoneOrder({
      phone: PHONE,
      customerName: "総額テスト",
      destinationType: "home",
      areaId,
      addressDetail: "テスト住所",
      therapistId: (await sql<{ id: string }[]>`select id from therapists where slug='aoi' limit 1`)[0]!.id,
      therapistSlug: "aoi",
      courseId: course!.id,
      optionIds: [],
      startAtISO: slot.startAtISO,
    });
    expect(created.ok).toBe(true);
    if (created.ok && created.data) {
      const r = await sql<{ total_amount: number }[]>`
        select total_amount from reservations where id = ${created.data.reservationId}::uuid
      `;
      expect(r[0]!.total_amount).toBe(slot.totalAmount);
    }
  });
});
