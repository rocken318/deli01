"use server";

import { z } from "zod";
import {
  getTherapistSlots,
  getFreeSlots,
  getPublicTherapistId,
  listPublicOptions,
} from "@/lib/availability/public-slots";
import type { PublicArea, PublicOption, PublicSlotView, BusyBlockView } from "@/lib/availability/public-slots";
import { confirmReservation, createHold, createFreeHold, releaseHold } from "@/lib/booking/holds";
import { listScheduleAreas } from "@/lib/schedule/queries";
import type { ConfirmResult, HoldResult } from "@/lib/booking/holds";
import { recordFunnelEvent } from "@/lib/booking/funnel";
import type { FunnelStep } from "@/lib/booking/funnel";

/**
 * 注文フローの Server Actions（フェーズ11 / spec 5-5・6章・付録B-2）。
 *
 * - 入力はすべて Zod で検証（spec 1-2）。クライアントの値を信用しない。
 * - 返すのは列挙コード・数値・id・時刻のみ。表示文言は CMS の ui_labels を
 *   ページ側が解決する（公開側 直書き日本語0 / 生 Postgres エラーを出さない）。
 */

const SessionSchema = z.string().min(8).max(100);

const SlotsInputSchema = z.object({
  slug: z.string().min(1).max(200),
  dateISO: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  areaId: z.string().uuid().nullable().optional(),
  courseId: z.string().uuid().nullable().optional(),
  optionIds: z.array(z.string().uuid()).max(50).optional(),
  hotelId: z.string().uuid().nullable().optional(),
});

export interface BookingSlotsResult {
  ok: boolean;
  slots: PublicSlotView[];
  busy: BusyBlockView[];
  windowStartISO: string | null;
  windowEndISO: string | null;
  areas: PublicArea[];
  areaId: string;
  areaName: string;
  assumed: boolean;
  dateISO: string;
  serviceMinutes: number;
}

/** 枠の再計算（spec 6章 手順2〜3。既存予約・ホールド込みの都度計算） */
export async function fetchBookingSlots(raw: unknown): Promise<BookingSlotsResult> {
  const parsed = SlotsInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      slots: [],
      busy: [],
      windowStartISO: null,
      windowEndISO: null,
      areas: [],
      areaId: "",
      areaName: "",
      assumed: false,
      dateISO: "",
      serviceMinutes: 0,
    };
  }
  const input = parsed.data;
  const result = await getTherapistSlots({
    slug: input.slug,
    dateISO: input.dateISO ?? null,
    areaId: input.areaId ?? null,
    courseId: input.courseId ?? null,
    optionIds: input.optionIds ?? [],
    hotelId: input.hotelId ?? null,
  });
  if (!result) {
    return {
      ok: true,
      slots: [],
      busy: [],
      windowStartISO: null,
      windowEndISO: null,
      areas: [],
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
    busy: result.busy,
    windowStartISO: result.windowStartISO,
    windowEndISO: result.windowEndISO,
    areas: result.areas,
    areaId: result.areaId,
    areaName: result.areaName,
    assumed: result.assumed,
    dateISO: result.dateISO,
    serviceMinutes: result.serviceMinutes,
  };
}

const FreeSlotsInputSchema = z.object({
  dateISO: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  areaId: z.string().uuid().nullable().optional(),
  courseId: z.string().uuid().nullable().optional(),
  optionIds: z.array(z.string().uuid()).max(50).optional(),
  hotelId: z.string().uuid().nullable().optional(),
});

/** フリー（おまかせ）: 全公開セラピストの空き枠を合算して返す（時間から選ぶ用） */
export async function fetchFreeSlots(raw: unknown): Promise<BookingSlotsResult> {
  const parsed = FreeSlotsInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      slots: [],
      busy: [],
      windowStartISO: null,
      windowEndISO: null,
      areas: [],
      areaId: "",
      areaName: "",
      assumed: false,
      dateISO: "",
      serviceMinutes: 0,
    };
  }
  const input = parsed.data;
  const [result, areas] = await Promise.all([
    getFreeSlots({
      dateISO: input.dateISO ?? null,
      areaId: input.areaId ?? null,
      courseId: input.courseId ?? null,
      optionIds: input.optionIds ?? [],
      hotelId: input.hotelId ?? null,
    }),
    listScheduleAreas(),
  ]);
  const areaList: PublicArea[] = areas.map((a) => ({ id: a.id, name: a.name }));
  if (!result) {
    return {
      ok: true,
      slots: [],
      busy: [],
      windowStartISO: null,
      windowEndISO: null,
      areas: areaList,
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
    busy: result.busy,
    windowStartISO: result.windowStartISO,
    windowEndISO: result.windowEndISO,
    areas: areaList,
    areaId: result.areaId,
    areaName: result.areaName,
    assumed: result.assumed,
    dateISO: result.dateISO,
    serviceMinutes: 0,
  };
}

const HoldInputSchema = z.object({
  slug: z.string().min(1).max(200),
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startAtISO: z.string().datetime(),
  areaId: z.string().uuid().nullable().optional(),
  courseId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).max(50).optional(),
  hotelId: z.string().uuid().nullable().optional(),
  sessionId: SessionSchema,
});

const FreeHoldInputSchema = z.object({
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startAtISO: z.string().datetime(),
  areaId: z.string().uuid().nullable().optional(),
  courseId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).max(50).optional(),
  hotelId: z.string().uuid().nullable().optional(),
  sessionId: SessionSchema,
});

/** フリー仮押さえ: 空いている担当を1人自動で押さえる（指名料なし） */
export async function holdFreeSlot(raw: unknown): Promise<HoldResult> {
  const parsed = FreeHoldInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const input = parsed.data;
  return createFreeHold({
    dateISO: input.dateISO,
    startAtISO: input.startAtISO,
    areaId: input.areaId ?? null,
    courseId: input.courseId,
    optionIds: input.optionIds ?? [],
    hotelId: input.hotelId ?? null,
    sessionId: input.sessionId,
  });
}

/** 仮押さえ（spec 5-5。exclusion 制約が同時取得を裁定する） */
export async function holdSlot(raw: unknown): Promise<HoldResult> {
  const parsed = HoldInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const input = parsed.data;
  return createHold({
    slug: input.slug,
    dateISO: input.dateISO,
    startAtISO: input.startAtISO,
    areaId: input.areaId ?? null,
    courseId: input.courseId,
    optionIds: input.optionIds ?? [],
    hotelId: input.hotelId ?? null,
    sessionId: input.sessionId,
  });
}

const ConfirmInputSchema = z.object({
  reservationId: z.string().uuid(),
  sessionId: SessionSchema,
  version: z.number().int().min(0),
  customerName: z.string().min(1).max(100),
  customerPhone: z.string().regex(/^0[0-9]{9,10}$/),
  addressDetail: z.string().min(1).max(500),
  addressLabel: z.string().max(100).nullable().optional(),
});

/** 確定（spec 6章 手順5〜10。version 楽観ロック） */
export async function confirmBooking(raw: unknown): Promise<ConfirmResult> {
  const parsed = ConfirmInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const input = parsed.data;
  return confirmReservation({
    reservationId: input.reservationId,
    sessionId: input.sessionId,
    version: input.version,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    addressDetail: input.addressDetail,
    addressLabel: input.addressLabel ?? null,
  });
}

const OptionsInputSchema = z.object({ slug: z.string().min(1).max(200) });

/** セラピスト対応オプションの取得（option_availability の絞り込み / spec 3-4） */
export async function fetchTherapistOptions(raw: unknown): Promise<PublicOption[]> {
  const parsed = OptionsInputSchema.safeParse(raw);
  if (!parsed.success) return [];
  const therapistId = await getPublicTherapistId(parsed.data.slug);
  if (!therapistId) return [];
  return listPublicOptions(therapistId);
}

const ReleaseInputSchema = z.object({
  reservationId: z.string().uuid(),
  sessionId: SessionSchema,
});

/** 自分のホールドの明示解放（時間を選び直すとき。session 一致行のみ） */
export async function releaseHeldSlot(raw: unknown): Promise<boolean> {
  const parsed = ReleaseInputSchema.safeParse(raw);
  if (!parsed.success) return false;
  return releaseHold(parsed.data);
}

const TrackInputSchema = z.object({
  sessionId: SessionSchema,
  step: z.enum(["visit", "view_therapist", "select_slot"]),
  therapistSlug: z.string().min(1).max(200).nullable().optional(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/**
 * ファネル計測の発火点（付録B-2）。visit / view_therapist / select_slot は
 * クライアントから呼ぶ（hold / confirm は各アクションのトランザクション内で記録）。
 * 計測失敗は握りつぶす（導線を止めない）。
 */
export async function trackFunnel(raw: unknown): Promise<void> {
  const parsed = TrackInputSchema.safeParse(raw);
  if (!parsed.success) return;
  const input = parsed.data;
  let therapistId: string | null = null;
  if (input.therapistSlug) {
    therapistId = await getPublicTherapistId(input.therapistSlug);
  }
  await recordFunnelEvent({
    sessionId: input.sessionId,
    step: input.step as FunnelStep,
    therapistId,
    meta: input.meta ?? {},
  });
}
