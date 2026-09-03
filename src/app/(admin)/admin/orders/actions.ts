'use server';

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { getTherapistSlots } from '@/lib/availability/public-slots';
import type { PublicSlotView } from '@/lib/availability/public-slots';
import {
  createHold,
  isOccupancyCheckError,
  isSlotTakenError,
  loadBookingFees,
  loadOptionSnapshots,
} from '@/lib/booking/holds';
import { feeBreakdown } from '@/domain/booking';
import { arrivalBuffers } from '@/domain/availability';
import type { BufferSettings } from '@/domain/availability';
import { totalServiceMinutes } from '@/domain/catalog';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 枠外（override）で engine の近傍枠が無いときの暫定移動時間（分・片道）。
 * 暫定は**保守的に長く**取る（占有を過小に見積もると exclusion をすり抜けて
 * 二重予約になるため / spec 4章・5-3。実移動が短ければ空白が出るだけで安全側）。
 */
const PROVISIONAL_OVERRIDE_TRAVEL_MIN = 30;

/** travel_buffers が未投入でも動く既定（spec 5-2。public-slots の FALLBACK と同値） */
const FALLBACK_OVERRIDE_BUFFERS: BufferSettings = {
  arriveMin: 10,
  parkingMin: 15,
  beforeMin: 5,
  afterMin: 10,
};

// Customer search result
export interface CustomerSearchResult {
  id: string;
  name: string;
  nameKana: string | null;
  note: string | null;
  // Latest home address
  addressDetail: string | null;
  areaId: string | null;
  areaName: string | null;
}

export async function searchCustomerByPhone(
  phone: string,
): Promise<ActionResult<CustomerSearchResult | null>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = z.string().regex(/^0[0-9]{9,10}$/).safeParse(phone);
  if (!parsed.success) return { ok: true, data: null };

  const sql = getClient();
  const rows = await withUser(sql, session, async (tx) => {
    return tx<{
      id: string;
      name: string;
      name_kana: string | null;
      note: string | null;
      address_detail: string | null;
      area_id: string | null;
      area_name: string | null;
    }[]>`
      select c.id, c.name, c.name_kana, c.note,
             a.detail as address_detail,
             a.area_id,
             ar.name as area_name
      from customers c
      left join addresses a on a.customer_id = c.id and a.kind = 'home'
      left join areas ar on ar.id = a.area_id
      where c.phone = ${parsed.data}
      order by a.created_at desc
      limit 1
    `;
  });

  const row = rows[0] ?? null;
  if (!row) return { ok: true, data: null };

  return {
    ok: true,
    data: {
      id: row.id,
      name: row.name,
      nameKana: row.name_kana,
      note: row.note,
      addressDetail: row.address_detail,
      areaId: row.area_id,
      areaName: row.area_name,
    },
  };
}

export interface HotelSearchResult {
  id: string;
  name: string;
  nameKana: string | null;
  areaId: string | null;
  areaName: string | null;
  extraMinutes: number;
  entryNote: string | null;
}

export async function searchHotels(
  query: string,
): Promise<ActionResult<HotelSearchResult[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const q = query.trim();
  if (q.length === 0) return { ok: true, data: [] };

  const sql = getClient();
  const rows = await withUser(sql, session, async (tx) => {
    return tx<{
      id: string;
      name: string;
      name_kana: string | null;
      area_id: string | null;
      area_name: string | null;
      extra_minutes: number;
      entry_note: string | null;
    }[]>`
      select h.id, h.name, h.name_kana, h.area_id,
             a.name as area_name,
             h.extra_minutes, h.entry_note
      from hotels h
      left join areas a on a.id = h.area_id
      where h.is_blocked = false
        and (h.name ilike ${'%' + q + '%'} or h.name_kana ilike ${'%' + q + '%'})
      order by h.name asc
      limit 10
    `;
  });

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      nameKana: r.name_kana,
      areaId: r.area_id,
      areaName: r.area_name,
      extraMinutes: r.extra_minutes,
      entryNote: r.entry_note,
    })),
  };
}

const lostOrderSchema = z.object({
  phone: z.string().optional(),
  areaId: z.string().uuid().optional(),
  reason: z.enum(['time', 'area', 'nomination', 'price', 'other']),
  note: z.string().optional(),
});

export async function createLostOrder(
  data: z.infer<typeof lostOrderSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = lostOrderSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  const sql = getClient();
  const result = await withUser(sql, session, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into lost_orders (phone, area_id, reason, note, created_by)
      values (
        ${parsed.data.phone ?? null},
        ${parsed.data.areaId ?? null}::uuid,
        ${parsed.data.reason}::lost_order_reason,
        ${parsed.data.note ?? null},
        ${session.userId}::uuid
      )
      returning id
    `;
    const row = rows[0];
    if (!row) throw new Error('insert failed');
    return { id: row.id };
  });

  return { ok: true, data: result };
}

// AvailableTherapistOption: セラピスト候補 + その枠
export interface AvailableTherapistOption {
  id: string;
  slug: string;
  name: string;
  slots: PublicSlotView[];
}

const getAvailableTherapistsSchema = z.object({
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  areaId: z.string().uuid().optional(),
  hotelId: z.string().uuid().optional(),
  courseId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).optional(),
  startAtISO: z.string().datetime().optional(),
});

/**
 * 指定コース/オプション/日付で枠が出るセラピストの候補リストを返す。
 * startAtISO 指定があればその枠を持つ人のみ。
 */
export async function getAvailableTherapists(params: {
  dateISO: string;
  areaId?: string;
  hotelId?: string;
  courseId: string;
  optionIds?: string[];
  startAtISO?: string;
}): Promise<ActionResult<AvailableTherapistOption[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsed = getAvailableTherapistsSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  const d = parsed.data;
  const sql = getClient();

  try {
    // active なセラピスト一覧を取得
    const therapistRows = await sql<{ id: string; slug: string; display_name: string | null }[]>`
      select t.id, t.slug,
             r.published->>'name' as display_name
      from therapists t
      left join entity_records r on r.entity = 'therapist' and r.slug = t.slug
      where t.status = 'active'
      order by t.display_order asc
    `;

    const candidates: AvailableTherapistOption[] = [];

    // 各セラピストについてエンジンで枠を確認
    for (const therapist of therapistRows) {
      const result = await getTherapistSlots({
        slug: therapist.slug,
        dateISO: d.dateISO,
        areaId: d.areaId ?? null,
        courseId: d.courseId,
        optionIds: d.optionIds ?? [],
        hotelId: d.hotelId ?? null,
      });

      if (!result || result.slots.length === 0) continue;

      let slots = result.slots;

      // startAtISO 指定があればその枠のみ
      if (d.startAtISO) {
        const targetMs = Date.parse(d.startAtISO);
        slots = slots.filter((s) => Date.parse(s.startAtISO) === targetMs);
        if (slots.length === 0) continue;
      }

      candidates.push({
        id: therapist.id,
        slug: therapist.slug,
        name: therapist.display_name ?? therapist.slug,
        slots,
      });
    }

    return { ok: true, data: candidates };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}

// OrderFormData: therapistId/therapistSlug 必須化
export interface OrderFormData {
  phone: string;
  customerName: string;
  destinationType: 'home' | 'hotel';
  addressDetail?: string;
  areaId?: string;
  hotelId?: string;
  roomNumber?: string;
  therapistId: string;     // 必須化（候補 UI で必ず選ばせる）
  therapistSlug: string;   // createHold の slug パラメータ用
  courseId: string;
  optionIds?: string[];
  startAtISO: string;
  /**
   * 枠を生成した営業日（work_date, JST yyyy-MM-dd）。省略時は startAtISO の
   * JST 暦日から導出する。**日跨ぎ枠**（深夜まで延びるシフトで開始が翌暦日に
   * なる枠）では暦日 ≠ 営業日のため、導出だと createHold が別 work_date の
   * シフトを引いて slot_gone になる。枠を出した呼び出し側（案内表/候補UI）が
   * その営業日を渡すことで、生成と作成の work_date を一致させる（判断#37）。
   */
  dateISO?: string;
  preferences?: string;
  overrideReason?: string; // 枠外のときのみ
}

const orderFormSchema = z.object({
  phone: z.string().regex(/^0[0-9]{9,10}$/),
  customerName: z.string().min(1),
  destinationType: z.enum(['home', 'hotel']),
  addressDetail: z.string().optional(),
  areaId: z.string().uuid().optional(),
  hotelId: z.string().uuid().optional(),
  roomNumber: z.string().max(50).optional(),
  therapistId: z.string().uuid(),        // 必須
  therapistSlug: z.string().min(1),      // 必須
  courseId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).optional(),
  startAtISO: z.string().datetime(),
  dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  preferences: z.string().optional(),
  overrideReason: z.string().optional(),
});

export async function createPhoneOrder(
  data: OrderFormData,
): Promise<ActionResult<{ reservationId: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const actor = toActor(session);

  // セラピスト未選択チェック（自動割当廃止 / 重大5）
  if (!data.therapistId || !data.therapistSlug) {
    return { ok: false, error: '候補セラピストを選択してください' };
  }

  const parsed = orderFormSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };
  }

  const d = parsed.data;
  const now = new Date();

  // エリア解決: hotelId からエリアを取得
  let resolvedAreaId: string | null = d.areaId ?? null;
  if (!resolvedAreaId && d.hotelId) {
    const sql = getClient();
    const hotels = await sql<{ area_id: string | null }[]>`
      select area_id from hotels where id = ${d.hotelId}::uuid limit 1
    `;
    resolvedAreaId = hotels[0]?.area_id ?? null;
  }

  // work_date（営業日）の決定。呼び出し側が枠を出した営業日を渡していれば
  // それを使う（日跨ぎ枠で暦日 ≠ 営業日のズレを避ける / 判断#37）。
  // 未指定時のみ startAtISO の JST 暦日から導出（従来動作）。
  let dateISO: string;
  if (d.dateISO) {
    dateISO = d.dateISO;
  } else {
    const startAtDate = new Date(d.startAtISO);
    // JST = UTC + 9h（getTherapistSlots は dateISO を使う）
    const jstDate = new Date(startAtDate.getTime() + 9 * 60 * 60 * 1000);
    dateISO = jstDate.toISOString().slice(0, 10);
  }

  // sessionId 生成（isValidFunnelSession は length 8-100 で pass）
  const sessionId = `phone:${session.userId}:${randomUUID()}`;

  try {
    // createHold を再利用（枠内ルート）
    const holdResult = await createHold({
      slug: d.therapistSlug,
      dateISO,
      startAtISO: d.startAtISO,
      areaId: resolvedAreaId,
      courseId: d.courseId,
      optionIds: d.optionIds ?? [],
      hotelId: d.hotelId ?? null,
      sessionId,
      now,
    });

    if (holdResult.ok) {
      // 枠内ルート: held → confirmed に遷移（phone 用）
      const sql = getClient();
      const result = await withUser(sql, session, async (tx) => {
        // 顧客 upsert
        const customers = await tx<{ id: string }[]>`
          insert into customers (phone, name)
          values (${d.phone}, ${d.customerName.trim()})
          on conflict (phone) do update
            set name = coalesce(nullif(customers.name, ''), excluded.name),
                updated_at = now()
          returning id
        `;
        const customerId = customers[0]?.id;
        if (!customerId) throw new Error('顧客の登録に失敗しました');

        // preferences があれば customers.note を更新
        if (d.preferences) {
          await tx`
            update customers set note = ${d.preferences} where id = ${customerId}::uuid
          `;
        }

        // 住所 insert
        const addresses = await tx<{ id: string }[]>`
          insert into addresses (customer_id, kind, hotel_id, label, detail, area_id)
          values (
            ${customerId}::uuid,
            ${d.destinationType === 'hotel' ? 'hotel' : 'home'}::address_kind,
            ${d.hotelId ?? null}::uuid,
            ${d.roomNumber ?? null},
            ${d.addressDetail ?? d.roomNumber ?? ''}::text,
            ${holdResult.areaId}::uuid
          )
          returning id
        `;
        const addressId = addresses[0]?.id;
        if (!addressId) throw new Error('住所の登録に失敗しました');

        // held → confirmed に遷移（楽観ロック: version = 0）
        const updated = await tx<{ version: number }[]>`
          update reservations
          set status = 'confirmed',
              customer_id = ${customerId}::uuid,
              address_id = ${addressId}::uuid,
              room_number = ${d.roomNumber ?? null},
              source = 'phone'::reservation_source,
              phone_confirmed_at = now(),
              phone_confirmed_by = ${session.userId}::uuid,
              version = version + 1
          where id = ${holdResult.reservationId}::uuid
            and status = 'held'
            and version = ${holdResult.version}
          returning version
        `;
        if (!updated[0]) throw new Error('予約の確定に失敗しました（楽観ロック競合）');

        // slot_holds を削除（期限切れ解放対象から外す）
        await tx`
          delete from slot_holds where reservation_id = ${holdResult.reservationId}::uuid
        `;

        return { reservationId: holdResult.reservationId };
      });

      return { ok: true, data: result };
    }

    // slot_gone: 枠外ルートへ
    if (holdResult.error === 'slot_gone' || holdResult.error === 'slot_taken') {
      // slot_taken は日本語エラー（推奨8）
      if (holdResult.error === 'slot_taken') {
        return {
          ok: false,
          error:
            '他のお客様の予約と重なりました。別の時間帯をお選びください',
        };
      }

      // slot_gone = 枠外。overrideReason が必要（重大2）
      if (!d.overrideReason || d.overrideReason.trim() === '') {
        return { ok: false, error: '枠外予約には理由が必要です' };
      }

      // override_slot 権限チェック（重大2）
      if (
        !can(actor, 'override_slot', { kind: 'slot_override', reason: d.overrideReason })
      ) {
        return { ok: false, error: '枠外予約の権限がありません' };
      }

      // 枠外ルート: engine を先に呼んで depart_at/free_at を暫定計算
      const engineResult = await getTherapistSlots({
        slug: d.therapistSlug,
        dateISO,
        areaId: resolvedAreaId,
        courseId: d.courseId,
        optionIds: d.optionIds ?? [],
        hotelId: d.hotelId ?? null,
        now,
      });

      const sql = getClient();

      // コース情報取得
      const courseRows = await sql<{
        id: string;
        price: number;
        duration_min: number;
        nomination_fee_default: number;
      }[]>`
        select id, price, duration_min, nomination_fee_default
        from courses where id = ${d.courseId}::uuid and is_active = true
        limit 1
      `;
      const course = courseRows[0];
      if (!course) return { ok: false, error: 'コースが見つかりません' };

      // セラピスト情報取得
      const therapistRows = await sql<{ id: string }[]>`
        select id from therapists where id = ${d.therapistId}::uuid and status = 'active' limit 1
      `;
      if (!therapistRows[0]) return { ok: false, error: 'セラピストが見つかりません' };

      const startAt = new Date(d.startAtISO);

      // オプションは engine と同じ絞り込み（is_active・is_public・option_availability の
      // セラピスト対応 / 重大A-4）。L・金額・スナップショットの材料を一度に取る
      const optionRows = await loadOptionSnapshots(sql, {
        optionIds: d.optionIds ?? [],
        therapistId: d.therapistId,
      });

      // L = コース + 選択オプション duration 合計（spec 3-4・5-3 / 重大A-1）。
      // 延長分を end_at / free_at に反映しないと exclusion をすり抜けて二重予約になる
      const serviceMinutes = totalServiceMinutes(
        course.duration_min,
        optionRows.map((o) => ({ durationMin: o.duration_min })),
      );

      // 占有区間の導出（engine の写像 = docs/booking-holds.md §4 / 重大A）:
      //   end_at  = s + buffer_before + L
      //   free_at = end_at + buffer_after
      //   depart_at = s − (到着バッファ + travel_in)
      // 近傍枠がある場合はその**相対オフセット**で写す（絶対時刻のコピーは
      // reservations_occupy_order_check 違反や意味ズレになる / 重大A-2）
      const nearbySlot = engineResult?.rawSlots.find(
        (s) =>
          Math.abs(s.startAt.getTime() - startAt.getTime()) < 60 * 60_000,
      );

      let serviceEndAt: Date;
      let departAt: Date;
      let freeAt: Date;
      let travelInMin: number;
      let travelOutMin: number;
      let bufferMin: number;
      let travelInMode: 'walk' | 'car';

      if (nearbySlot) {
        // 相対オフセット: departOffset = 到着バッファ + travel_in / freeOffset = buffer_after
        const departOffsetMin =
          (nearbySlot.startAt.getTime() - nearbySlot.departAt.getTime()) / 60_000;
        const freeOffsetMin =
          (nearbySlot.freeAt.getTime() - nearbySlot.serviceEndAt.getTime()) / 60_000;
        serviceEndAt = new Date(
          startAt.getTime() + (nearbySlot.buffers.beforeMin + serviceMinutes) * 60_000,
        );
        departAt = new Date(startAt.getTime() - departOffsetMin * 60_000);
        freeAt = new Date(serviceEndAt.getTime() + freeOffsetMin * 60_000);
        travelInMin = nearbySlot.travelInMin;
        travelOutMin = nearbySlot.travelOutMin;
        bufferMin = nearbySlot.bufferTotalMin;
        travelInMode = nearbySlot.travelInMode;
      } else {
        // 近傍枠なし（シフト外深夜等）の最終手段（重大A-3）: 暫定バッファも
        // end_at には必ず L を反映し、free_at = end_at + after を守る。
        // 移動手段は walk 固定にせず car を明示（駐車バッファ込み・片道30分の
        // 保守的な暫定値。過小見積もりで exclusion をすり抜けない / 推奨4）
        const bufferRows = await sql<{
          arrive_min: number;
          parking_min: number;
          before_min: number;
          after_min: number;
        }[]>`
          select arrive_min, parking_min, before_min, after_min
          from travel_buffers where scope = 'default' limit 1
        `;
        const defaults: BufferSettings = bufferRows[0]
          ? {
              arriveMin: bufferRows[0].arrive_min,
              parkingMin: bufferRows[0].parking_min,
              beforeMin: bufferRows[0].before_min,
              afterMin: bufferRows[0].after_min,
            }
          : FALLBACK_OVERRIDE_BUFFERS;
        let hotelExtraMinutes = 0;
        if (d.hotelId) {
          const hotelRows = await sql<{ extra_minutes: number }[]>`
            select extra_minutes from hotels where id = ${d.hotelId}::uuid limit 1
          `;
          hotelExtraMinutes = hotelRows[0]?.extra_minutes ?? 0;
        }
        const buffers = arrivalBuffers({
          mode: 'car',
          defaults,
          destination: {
            kind: d.destinationType === 'hotel' ? 'hotel' : 'residence',
            hotelExtraMinutes,
          },
        });
        travelInMode = 'car';
        travelInMin = PROVISIONAL_OVERRIDE_TRAVEL_MIN;
        travelOutMin = PROVISIONAL_OVERRIDE_TRAVEL_MIN;
        serviceEndAt = new Date(
          startAt.getTime() + (buffers.beforeMin + serviceMinutes) * 60_000,
        );
        departAt = new Date(
          startAt.getTime() - (buffers.arrivalTotalMin + travelInMin) * 60_000,
        );
        freeAt = new Date(serviceEndAt.getTime() + buffers.afterMin * 60_000);
        bufferMin = buffers.arrivalTotalMin + buffers.beforeMin + buffers.afterMin;
      }

      // 料金計算（サーバ側で計算 / クライアント値無視）
      const bookingFees = await loadBookingFees();
      // エリア別交通費（車のとき使う。徒歩圏は 0 / 発注者決定 2026-09-04）
      const feeAreaId = resolvedAreaId ?? engineResult?.areaId ?? null;
      const areaFeeRows = feeAreaId
        ? await sql<{ transport_fee: number }[]>`
            select transport_fee from areas where id = ${feeAreaId}::uuid limit 1
          `
        : [];
      const breakdown = feeBreakdown({
        coursePrice: course.price,
        optionPrices: optionRows.map((o) => o.price),
        nominationFee: course.nomination_fee_default,
        travelInMode,
        startAt,
        settings: bookingFees,
        areaTransportFee: areaFeeRows[0]?.transport_fee ?? null,
      });

      const result = await withUser(sql, session, async (tx) => {
        // 顧客 upsert
        const customers = await tx<{ id: string }[]>`
          insert into customers (phone, name)
          values (${d.phone}, ${d.customerName.trim()})
          on conflict (phone) do update
            set name = coalesce(nullif(customers.name, ''), excluded.name),
                updated_at = now()
          returning id
        `;
        const customerId = customers[0]?.id;
        if (!customerId) throw new Error('顧客の登録に失敗しました');

        if (d.preferences) {
          await tx`
            update customers set note = ${d.preferences} where id = ${customerId}::uuid
          `;
        }

        const effectiveAreaId = resolvedAreaId ?? (engineResult?.areaId ?? null);
        if (!effectiveAreaId) throw new Error('エリアを特定できませんでした');

        const addresses = await tx<{ id: string }[]>`
          insert into addresses (customer_id, kind, hotel_id, label, detail, area_id)
          values (
            ${customerId}::uuid,
            ${d.destinationType === 'hotel' ? 'hotel' : 'home'}::address_kind,
            ${d.hotelId ?? null}::uuid,
            ${d.roomNumber ?? null},
            ${d.addressDetail ?? d.roomNumber ?? ''}::text,
            ${effectiveAreaId}::uuid
          )
          returning id
        `;
        const addressId = addresses[0]?.id;
        if (!addressId) throw new Error('住所の登録に失敗しました');

        // 直接 confirmed で insert
        const reservations = await tx<{ id: string }[]>`
          insert into reservations (
            therapist_id, customer_id, address_id, area_id, course_id,
            hotel_id, start_at, end_at, depart_at, free_at,
            travel_in_min, travel_out_min, buffer_min,
            status, nomination_fee, transport_fee, total_amount,
            source, phone_confirmed_at, phone_confirmed_by, room_number -- room_number（0025 専用列）
          ) values (
            ${d.therapistId}::uuid,
            ${customerId}::uuid,
            ${addressId}::uuid,
            ${effectiveAreaId}::uuid,
            ${d.courseId}::uuid,
            ${d.hotelId ?? null}::uuid,
            ${startAt}, ${serviceEndAt}, ${departAt}, ${freeAt},
            ${travelInMin}, ${travelOutMin}, ${bufferMin},
            'confirmed'::reservation_status,
            ${breakdown.nominationFee}, ${breakdown.transportFee}, ${breakdown.totalAmount},
            'phone'::reservation_source,
            now(),
            ${session.userId}::uuid,
            ${d.roomNumber ?? null}
          )
          returning id
        `;
        const reservationId = reservations[0]?.id;
        if (!reservationId) throw new Error('予約の作成に失敗しました');

        // オプションのスナップショット（L の計算に使った内容と必ず一致 / spec 3-4）
        for (const opt of optionRows) {
          await tx`
            insert into reservation_options (
              reservation_id, option_id, price_snapshot, duration_snapshot,
              back_type_snapshot, back_value_snapshot
            ) values (
              ${reservationId}::uuid, ${opt.id}::uuid, ${opt.price}, ${opt.duration_min},
              ${opt.back_type}::option_back_type, ${opt.back_value}
            )
          `;
        }

        // audit_log に override を記録（必須）
        await tx`
          insert into audit_logs (actor_user_id, action, entity, entity_id, after)
          values (
            ${session.userId}::uuid,
            'override',
            'reservation',
            ${reservationId}::uuid,
            ${tx.json({ reason: d.overrideReason ?? '', source: 'phone' } satisfies { reason: string; source: string })}
          )
        `;

        return { reservationId };
      });

      return { ok: true, data: result };
    }

    // invalid
    return { ok: false, error: '無効なパラメータです' };
  } catch (e) {
    // 生の Postgres エラーを画面に出さない（spec 4章。override の手動 insert 経路も含む）
    if (isSlotTakenError(e)) {
      return {
        ok: false,
        error: '他のお客様の予約と重なりました。別の時間帯をお選びください',
      };
    }
    if (isOccupancyCheckError(e)) {
      return {
        ok: false,
        error: '予約の占有時間の前後関係が不正です。開始時刻を見直してください',
      };
    }
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}

// UnconfirmedReservation: 電話未確認の予約
export interface UnconfirmedReservation {
  id: string;
  customerName: string;
  customerPhone: string;
  startAtISO: string;
  therapistName: string;
  source: string;
  /** 架電記録の件数（call_logs）。0 なら未架電 */
  callCount: number;
  /** 直近の架電結果（confirmed/no_answer/other）。未架電なら null */
  lastResult: string | null;
  /** 直近の架電日時 ISO。未架電なら null */
  lastCalledAtISO: string | null;
}

/**
 * phone_confirmed_at が null かつ status='confirmed' の予約一覧を返す。
 * 電話確認画面用。
 */
export async function listUnconfirmedReservations(): Promise<
  ActionResult<UnconfirmedReservation[]>
> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const sql = getClient();
  const rows = await withUser(sql, session, async (tx) => {
    return tx<{
      id: string;
      customer_name: string;
      customer_phone: string;
      start_at: Date;
      therapist_name: string | null;
      therapist_slug: string;
      source: string;
      call_count: number;
      last_result: string | null;
      last_called_at: Date | null;
    }[]>`
      select r.id,
             c.name as customer_name,
             c.phone as customer_phone,
             r.start_at,
             er.published->>'name' as therapist_name,
             t.slug as therapist_slug,
             r.source::text,
             coalesce(cl.cnt, 0)::int as call_count,
             cl.last_result,
             cl.last_called_at
      from reservations r
      join customers c on c.id = r.customer_id
      join therapists t on t.id = r.therapist_id
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      left join lateral (
        select count(*) as cnt,
               (array_agg(result::text order by called_at desc))[1] as last_result,
               max(called_at) as last_called_at
        from call_logs where reservation_id = r.id
      ) cl on true
      where r.status = 'confirmed'
        and r.phone_confirmed_at is null
        and r.source = 'web'::reservation_source
      order by r.start_at asc
      limit 50
    `;
  });

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      startAtISO: r.start_at.toISOString(),
      therapistName: r.therapist_name ?? r.therapist_slug,
      source: r.source,
      callCount: r.call_count,
      lastResult: r.last_result,
      lastCalledAtISO: r.last_called_at ? r.last_called_at.toISOString() : null,
    })),
  };
}

/**
 * 電話確認を記録する（spec 6章★ / 重大B 対応）。
 * - phone_confirmed_at / phone_confirmed_by は **callResult='confirmed' のときだけ**設定
 *   （不通を確認済みにすると住所入り配車テキストが解禁されてしまう）
 * - no_answer / other は call_logs 追記のみ（未確認のまま再架電可・version 不変）
 * - confirmed の重複実行は「既に電話確認済み」で拒否（楽観ロック相当のガード）
 */
export async function confirmPhoneCall(
  reservationId: string,
  callResult: 'confirmed' | 'no_answer' | 'other',
  note?: string,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const parsedId = z.string().uuid().safeParse(reservationId);
  if (!parsedId.success) return { ok: false, error: '無効な予約IDです' };

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      if (callResult === 'confirmed') {
        // 確認が取れたときだけ phone_confirmed_at / phone_confirmed_by を設定する
        // （spec 6章★ / 重大B。不通を確認済みにすると canGenerateDispatch=true になり
        // 住所入り配車テキストが解禁されてしまう）。
        // 楽観ロック: status='confirmed' で phone_confirmed_at is null の行のみ更新
        const updated = await tx<{ version: number }[]>`
          update reservations
          set phone_confirmed_at = now(),
              phone_confirmed_by = ${session.userId}::uuid,
              version = version + 1,
              updated_at = now()
          where id = ${parsedId.data}::uuid
            and status = 'confirmed'
            and phone_confirmed_at is null
          returning version
        `;

        if (!updated[0]) {
          // 既に確認済み or 存在しないはエラー
          throw new Error('予約が見つからないか、既に電話確認済みです');
        }
      } else {
        // 不通（no_answer）/ その他は**確認済みにしない**。call_logs の追記のみ行い、
        // 未確認のまま再架電を許す（spec 6章「3回不通で自動キャンセル」の運用が
        // 成立するように。version の増分も confirmed 時のみ）
        const rows = await tx<{ id: string }[]>`
          select id from reservations
          where id = ${parsedId.data}::uuid and status = 'confirmed'
          limit 1
        `;
        if (!rows[0]) {
          throw new Error('予約が見つかりません');
        }
      }

      // call_logs に記録（confirmed / no_answer / other すべて）
      await tx`
        insert into call_logs (reservation_id, result, note, called_by)
        values (
          ${parsedId.data}::uuid,
          ${callResult}::call_result,
          ${note ?? null},
          ${session.userId}::uuid
        )
      `;
    });

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}

export async function getAvailableSlots(
  date: string,
  therapistSlug?: string,
): Promise<ActionResult<PublicSlotView[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  if (!therapistSlug) {
    return { ok: true, data: [] };
  }

  try {
    const result = await getTherapistSlots({ slug: therapistSlug, dateISO: date });
    if (!result) return { ok: true, data: [] };
    return { ok: true, data: result.slots };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}

/**
 * 未登録ホテルの仮登録（推奨11）。
 * name のみで insert（area_id null, extra_minutes 0, is_blocked false）。
 */
export async function registerProvisionalHotel(
  name: string,
): Promise<ActionResult<{ id: string; name: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };

  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'ホテル名を入力してください' };

  const sql = getClient();
  try {
    const result = await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string; name: string }[]>`
        insert into hotels (name, extra_minutes, is_blocked)
        values (${trimmed}, 0, false)
        returning id, name
      `;
      const row = rows[0];
      if (!row) throw new Error('仮登録に失敗しました');
      return { id: row.id, name: row.name };
    });
    return { ok: true, data: result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '不明なエラー';
    return { ok: false, error: msg };
  }
}
