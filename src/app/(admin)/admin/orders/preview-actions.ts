"use server";

/**
 * 総額プレビュー（作成しない）。案内表のインライン予約ポップが電話中に総額を出すため。
 * createPhoneOrder と同じ `feeBreakdown`（純関数）を使う＝料金ロジックの再実装なし。
 */

import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import { feeBreakdown } from "@/domain/booking";
import { loadBookingFees } from "@/lib/booking/holds";

export interface PreviewInput {
  courseId: string;
  optionIds: string[];
  startAtISO: string;
  travelInMode: "walk" | "car";
}
export type PreviewResult =
  | { ok: true; data: { nominationFee: number; transportFee: number; totalAmount: number } }
  | { ok: false; error: string };

export async function previewOrderTotal(input: PreviewInput): Promise<PreviewResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const sql = getClient();
  const courses = await sql<{ price: number; nomination_fee_default: number }[]>`
    select price, nomination_fee_default from courses where id = ${input.courseId}::uuid limit 1
  `;
  const course = courses[0];
  if (!course) return { ok: false, error: "コースが見つかりません" };

  const options =
    input.optionIds.length > 0
      ? await sql<{ price: number }[]>`select price from options where id = any(${input.optionIds}::uuid[])`
      : [];

  const settings = await loadBookingFees();
  const b = feeBreakdown({
    coursePrice: course.price,
    optionPrices: options.map((o) => o.price),
    nominationFee: course.nomination_fee_default,
    travelInMode: input.travelInMode,
    startAt: new Date(input.startAtISO),
    settings,
  });
  return {
    ok: true,
    data: { nominationFee: b.nominationFee, transportFee: b.transportFee, totalAmount: b.totalAmount },
  };
}
