"use server";

/**
 * 案内表インライン予約の「実枠＋総額」取得（P1b）。
 * getTherapistSlots（engine 再計算・createHold と同一経路）で valid な開始時刻を引き、
 * 各枠の travelInMode と loadOptionSnapshots（is_active/is_public/option_availability 絞込）
 * を使って feeBreakdown で総額を出す＝**選んだ枠＝作成される予約の総額と一致**（reviewer B1/B2）。
 */

import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { feeBreakdown } from "@/domain/booking";
import { getTherapistSlots } from "@/lib/availability/public-slots";
import { loadOptionSnapshots, loadBookingFees } from "@/lib/booking/holds";

const TZ = "Asia/Tokyo";

const schema = z.object({
  therapistSlug: z.string().min(1),
  courseId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).default([]),
  areaId: z.string().uuid().nullable().optional(),
  hotelId: z.string().uuid().nullable().optional(),
});

export interface AnnaiSlot {
  startAtISO: string;
  time: string; // "HH:mm" JST
  totalAmount: number;
}
export type AnnaiSlotsResult =
  | { ok: true; data: { slots: AnnaiSlot[]; areaName: string | null; assumed: boolean; dateISO: string } }
  | { ok: false; error: string };

export async function getAnnaiBookingSlots(input: z.infer<typeof schema>): Promise<AnnaiSlotsResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  if (!can(toActor(session), "manage_reservations")) return { ok: false, error: "権限がありません" };

  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "入力を確認してください" };
  const d = parsed.data;

  const dateISO = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
  try {
    const res = await getTherapistSlots({
      slug: d.therapistSlug,
      dateISO,
      areaId: d.areaId ?? null,
      hotelId: d.hotelId ?? null,
      courseId: d.courseId,
      optionIds: d.optionIds,
    });
    if (!res || !res.therapistId) {
      return { ok: true, data: { slots: [], areaName: res?.areaName ?? null, assumed: false, dateISO } };
    }

    const sql = getClient();
    const courses = await sql<{ price: number; nomination_fee_default: number }[]>`
      select price, nomination_fee_default from courses
      where id = ${d.courseId}::uuid and is_active = true limit 1
    `;
    const course = courses[0];
    if (!course) return { ok: false, error: "コースが見つかりません" };

    const opts = await loadOptionSnapshots(sql, { optionIds: d.optionIds, therapistId: res.therapistId });
    const optionPrices = opts.map((o) => o.price);
    const settings = await loadBookingFees();

    const slots: AnnaiSlot[] = res.rawSlots.map((slot) => {
      const b = feeBreakdown({
        coursePrice: course.price,
        optionPrices,
        nominationFee: course.nomination_fee_default,
        travelInMode: slot.travelInMode,
        startAt: slot.startAt,
        settings,
      });
      return {
        startAtISO: slot.startAt.toISOString(),
        time: formatInTimeZone(slot.startAt, TZ, "HH:mm"),
        totalAmount: b.totalAmount,
      };
    });

    return { ok: true, data: { slots, areaName: res.areaName, assumed: res.assumed, dateISO } };
  } catch (e) {
    console.error("getAnnaiBookingSlots failed:", e);
    return { ok: false, error: "枠の取得に失敗しました" };
  }
}
