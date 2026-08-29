"use server";

import { z } from "zod";
import { getTherapistSlots } from "@/lib/availability/public-slots";
import type { PublicSlotView } from "@/lib/availability/public-slots";

/**
 * 個人ページの空き枠再計算 Server Action（フェーズ10 / spec 2-3・5-3）。
 *
 * エリア/コース/オプションのセレクタが変わるたびに呼ばれ、**都度計算**した候補枠を
 * 返す（キャッシュしない / spec 2-7）。入力は Zod で検証（spec 1-2）。
 * 文言は返さない（数値・id・時刻のみ）。表示文言はクライアントが content 由来の
 * props で持つため、直書き日本語はここにも無い。
 */

const InputSchema = z.object({
  slug: z.string().min(1).max(200),
  dateISO: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  areaId: z.string().uuid().nullable().optional(),
  courseId: z.string().uuid().nullable().optional(),
  optionIds: z.array(z.string().uuid()).max(50).optional(),
});

export interface RecomputeSlotsResult {
  ok: boolean;
  slots: PublicSlotView[];
  areaId: string;
  areaName: string;
  assumed: boolean;
  dateISO: string;
  serviceMinutes: number;
}

/**
 * 指定条件で候補枠を返す。対応エリア外・出勤なし・非公開セラピストは
 * ok:true・slots:[] で返す（画面は空状態を出す）。
 * ok:false を返すのは入力不正（Zod 失敗）のみ。
 */
export async function recomputeSlots(
  raw: unknown,
): Promise<RecomputeSlotsResult> {
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) {
    return emptyFail();
  }
  const input = parsed.data;

  const result = await getTherapistSlots({
    slug: input.slug,
    dateISO: input.dateISO ?? null,
    areaId: input.areaId ?? null,
    courseId: input.courseId ?? null,
    optionIds: input.optionIds ?? [],
  });

  // 非公開/不在/エリア外の明示指定 → null。画面は空状態（嘘の枠を出さない / spec 2-3）
  if (!result) {
    return {
      ok: true,
      slots: [],
      areaId: input.areaId ?? "",
      areaName: "",
      assumed: !input.areaId,
      dateISO: input.dateISO ?? "",
      serviceMinutes: 0,
    };
  }

  return {
    ok: true,
    slots: result.slots,
    areaId: result.areaId,
    areaName: result.areaName,
    assumed: result.assumed,
    dateISO: result.dateISO,
    serviceMinutes: result.serviceMinutes,
  };
}

function emptyFail(): RecomputeSlotsResult {
  return {
    ok: false,
    slots: [],
    areaId: "",
    areaName: "",
    assumed: false,
    dateISO: "",
    serviceMinutes: 0,
  };
}
