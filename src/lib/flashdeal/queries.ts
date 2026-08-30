import "server-only";
import type { Sql } from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import { flashDiscount, isFlashEligible } from "@/domain/flashdeal";
import type { FlashDealConfig, FlashIneligibleReason } from "@/domain/flashdeal";

/**
 * 直前割の適用コア（フェーズ20 ★金銭 / spec L650-654・受入 L1120・L1121）。
 *
 * 金銭計上の設計:
 * - 割引は revenue_lines の line_type='discount' **負行**として計上する（spec L653 /
 *   0015 の符号規約）。reservations.total_amount は**割引前のまま動かさない**:
 *   フェーズ18 の buildReservationPayout はコース定価を total_amount の残差
 *   （= 値引前）として立て、discount 行を別途読んで
 *   payout_policy.discount_base（既定 'before' / spec L653・11-3）に応じて
 *   基礎から控除する既存挙動のため、ここで total_amount を書き換えると二重控除になる。
 *   顧客の支払額 = total_amount + Σdiscount（負）で、表示側が合成する。
 * - 割引率の適用基礎 = reservations.total_amount（割引前の予約合計）。
 *   spec は基礎を明文化していないため雛形として合計に対する率とした
 *   （発注者確認事項。率・上限とも CMS 設定で、既定 enabled=false）。
 *
 * 防衛線（アプリのチェックだけに頼らない）:
 * - 二重適用: flash_deals の unique(reservation_id)（事前 select は早期リターン用）
 * - 1日上限（受入 L1120）: pg_advisory_xact_lock で「JST 営業日」単位に直列化した上で
 *   flash_deals の日次カウントを判定（並行トランザクションの racing で上限を
 *   すり抜けない）
 * - JST の時・営業日は DB の `at time zone 'Asia/Tokyo'` で確定（文字列で計算しない）
 */

export interface ApplyFlashDealParams {
  reservationId: string;
  /** CMS 設定。actions.ts が loadFlashDealConfig で渡す（テストは直接注入） */
  config: FlashDealConfig;
  now?: Date;
}

export type ApplyFlashDealOutcome =
  | { kind: "applied"; discount: number; ratePercent: number; appliedOn: string }
  | { kind: "not_found" }
  | { kind: "already_applied" }
  | { kind: "bad_status"; status: string }
  | { kind: "already_started" }
  | { kind: "not_eligible"; reason: FlashIneligibleReason }
  | { kind: "zero_discount" };

function pgCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

export async function applyFlashDealCore(
  sql: Sql,
  session: Session,
  params: ApplyFlashDealParams,
): Promise<ApplyFlashDealOutcome> {
  const now = params.now ?? new Date();
  try {
    return await withUser(sql, session, async (tx) => {
      // 予約 + JST 派生値を DB で確定（行ロックで status 遷移と競合しない）
      const rows = await tx<
        {
          id: string;
          status: string;
          course_id: string;
          area_id: string;
          therapist_id: string;
          total_amount: number;
          is_flash_deal: boolean;
          start_at: Date;
          started: boolean;
          start_day_jst: string;
          start_hour_jst: number;
          now_day_jst: string;
          now_hour_jst: number;
        }[]
      >`
        select r.id, r.status::text as status, r.course_id, r.area_id,
               r.therapist_id, r.total_amount, r.is_flash_deal, r.start_at,
               (r.start_at <= ${now}::timestamptz) as started,
               to_char(r.start_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as start_day_jst,
               extract(hour from r.start_at at time zone 'Asia/Tokyo')::int as start_hour_jst,
               to_char(${now}::timestamptz at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as now_day_jst,
               extract(hour from ${now}::timestamptz at time zone 'Asia/Tokyo')::int as now_hour_jst
        from reservations r
        where r.id = ${params.reservationId}::uuid
        for update
      `;
      const r = rows[0];
      if (!r) return { kind: "not_found" } as const;
      if (r.is_flash_deal) return { kind: "already_applied" } as const;
      // 適用対象は確定済み予約のみ（held は金額未確定・done 以降は事後改変になる）
      if (r.status !== "confirmed") {
        return { kind: "bad_status", status: r.status } as const;
      }
      if (r.started) return { kind: "already_started" } as const;

      // 事前判定（最終防衛線は flash_deals の unique(reservation_id)）
      const dup = await tx<{ n: number }[]>`
        select count(*)::int as n from flash_deals
        where reservation_id = ${r.id}::uuid
      `;
      if ((dup[0]?.n ?? 0) > 0) return { kind: "already_applied" } as const;

      // ★1日上限の直列化（受入 L1120）: JST 営業日単位の advisory lock。
      // これ無しでは並行 2 トランザクションが同時に「上限未満」を観測して
      // 上限を 1 件超え得る。tx 終了（commit/rollback）で自動解放。
      await tx`
        select pg_advisory_xact_lock(hashtext(${"flash_deals:" + r.now_day_jst}))
      `;
      const cntRows = await tx<{ n: number }[]>`
        select count(*)::int as n from flash_deals
        where applied_on = ${r.now_day_jst}::date
      `;
      const appliedTodayCount = cntRows[0]?.n ?? 0;

      const eligibility = isFlashEligible({
        config: params.config,
        startHourJst: r.start_hour_jst,
        nowHourJst: r.now_hour_jst,
        isSameDayJst: r.start_day_jst === r.now_day_jst,
        courseId: r.course_id,
        appliedTodayCount,
      });
      if (!eligibility.eligible) {
        return { kind: "not_eligible", reason: eligibility.reason } as const;
      }

      // 割引額（円・整数・floor）。基礎 = 割引前の予約合計（ファイル冒頭コメント参照）
      const discount = flashDiscount({
        baseAmount: r.total_amount,
        ratePercent: params.config.ratePercent,
      });
      if (discount <= 0) return { kind: "zero_discount" } as const;

      // 1. revenue_lines へ discount 負行（spec L653 / 0015 符号規約）。
      //    occurred_at は施術日基準（予約由来の行の規約）。note に計算根拠を控える
      const rlRows = await tx<{ id: string }[]>`
        insert into revenue_lines
          (reservation_id, line_type, amount, area_id, therapist_id, occurred_at,
           note, created_by)
        values
          (${r.id}::uuid, 'discount', ${-discount}, ${r.area_id}::uuid,
           ${r.therapist_id}::uuid, ${r.start_at},
           ${`flash_deal ${params.config.ratePercent}% of ${r.total_amount} = ${discount}`},
           ${session.userId}::uuid)
        returning id::text as id
      `;
      const revenueLineId = rlRows[0];
      if (!revenueLineId) throw new Error("discount revenue_line insert returned no row");

      // 2. flash_deals へ適用履歴（unique(reservation_id) = 二重適用の最終防衛線）
      await tx`
        insert into flash_deals
          (reservation_id, rate_percent, amount, applied_on, revenue_line_id, created_by)
        values
          (${r.id}::uuid, ${params.config.ratePercent}, ${discount},
           ${r.now_day_jst}::date, ${revenueLineId.id}::bigint, ${session.userId}::uuid)
      `;

      // 3. 公開ラベル用の印（spec L654）+ 楽観ロックの版を進める
      await tx`
        update reservations
        set is_flash_deal = true, version = version + 1
        where id = ${r.id}::uuid
      `;

      // 4. 監査ログ（金銭に関わる操作は必ず記録）
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid, 'flash_deal_apply', 'reservation', ${r.id}::uuid,
          ${tx.json({
            rate_percent: params.config.ratePercent,
            amount: discount,
            base_amount: r.total_amount,
            applied_on: r.now_day_jst,
          })}
        )
      `;

      return {
        kind: "applied",
        discount,
        ratePercent: params.config.ratePercent,
        appliedOn: r.now_day_jst,
      } as const;
    });
  } catch (e) {
    // 並行実行が unique(reservation_id) に当たった場合（tx はロールバック済み）
    if (pgCode(e) === "23505") return { kind: "already_applied" };
    throw e;
  }
}
