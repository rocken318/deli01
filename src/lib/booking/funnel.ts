import "server-only";
import type { TransactionSql } from "postgres";
import postgres from "postgres";
import { getClient } from "@/lib/db-client";

/**
 * 予約ファネル計測（フェーズ11 / spec 6章「計測」・付録B-2）。
 *
 * 「訪問 → セラピスト閲覧 → 枠選択 → 仮押さえ → 確定」の各段階を
 * funnel_events に追記する。離脱地点の集計はこのテーブルだけを読む。
 *
 * - session_id は公開側の匿名セッション（クライアント生成の UUID。個人情報を持たない）
 * - visit / view_therapist / select_slot はクライアント発火（trackFunnel Server Action）
 * - hold / confirm は仮押さえ・確定のトランザクション内で記録する（取引と計測が
 *   確実に一致する）
 * - 計測の失敗で予約を壊さない: record* は例外を投げず false を返す（tx 内は除く）
 */

export const FUNNEL_STEPS = [
  "visit",
  "view_therapist",
  "select_slot",
  "hold",
  "confirm",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** session_id の緩い制約（クライアント生成値。長さだけ絞る） */
export function isValidFunnelSession(sessionId: string): boolean {
  return sessionId.length >= 8 && sessionId.length <= 100;
}

/**
 * ファネルイベントを1件記録する（トランザクション外の発火点用）。
 * 失敗しても投げない（計測のために予約導線を止めない）。
 */
export async function recordFunnelEvent(params: {
  sessionId: string;
  step: FunnelStep;
  therapistId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  if (!isValidFunnelSession(params.sessionId)) return false;
  try {
    const sql = getClient();
    await insertFunnelEvent(sql, params);
    return true;
  } catch (e) {
    console.error("funnel_events の記録に失敗:", e);
    return false;
  }
}

/**
 * トランザクション内での記録（hold / confirm 用）。失敗はロールバックに乗せる
 * （仮押さえと計測の不一致を作らない）。
 */
export async function insertFunnelEvent(
  sql: TransactionSql | ReturnType<typeof getClient>,
  params: {
    sessionId: string;
    step: FunnelStep;
    therapistId?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    insert into funnel_events (session_id, step, therapist_id, meta)
    values (
      ${params.sessionId},
      ${params.step}::funnel_step,
      ${params.therapistId ?? null}::uuid,
      ${sql.json((params.meta ?? {}) as postgres.JSONValue)}
    )
  `;
}
