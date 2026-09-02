"use server";

/**
 * 受付表の進行チェックポイント（入室電話）＋清算（集金照合）の Server Actions（P2）。
 * owner/admin/reception のみ（can manage_reservations）。RLS 下（withUser）で実行。
 * 会計台帳(revenue_lines)は別系統。ここは運用の照合記録（回収額・照合・誰が/いつ・差額メモ）。
 * 再清算は拒否（追記専用）・締めた事実は audit_logs に追記。
 * カード決済URLは配線のみ（オンライン決済は spec「やらないこと」＝実処理は作らない）。
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { getDevSession } from "@/lib/cms/dev-session";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { recordEntryCallCore, settleReservationCore } from "./checkpoint-queries";

const uuid = z.string().uuid();

export type CheckpointResult = { ok: true; at: string } | { ok: false; error: string };
export type SettleActionResult =
  | { ok: true; data: { totalAmount: number; collectedAmount: number; diff: number; reconciledAt: string } }
  | { ok: false; error: string };

async function guard() {
  const session = await getDevSession();
  if (!session) return { session: null, error: "認証が必要です" as const };
  if (!can(toActor(session), "manage_reservations")) return { session: null, error: "権限がありません" as const };
  return { session, error: null };
}

/** 入室電話（お客様から入室連絡）を記録。 */
export async function recordEntryCall(reservationId: string): Promise<CheckpointResult> {
  const parsed = uuid.safeParse(reservationId);
  if (!parsed.success) return { ok: false, error: "不正な予約です" };
  const g = await guard();
  if (!g.session) return { ok: false, error: g.error };

  try {
    const sql = getClient();
    const rec = await withUser(sql, g.session, (tx) => recordEntryCallCore(tx, parsed.data, Date.now()));
    if (!rec) return { ok: false, error: "記録できませんでした（既に記録済み、または対象外の状態です）" };
    revalidatePath(`/admin/reservations/${parsed.data}`);
    return { ok: true, at: rec.entryCallAt.toISOString() };
  } catch {
    return { ok: false, error: "記録に失敗しました" };
  }
}

const settleInput = z.object({
  reservationId: uuid,
  collectedAmount: z.number().int().min(0).max(10_000_000),
  isCard: z.boolean(),
  note: z.string().max(500).default(""),
});

/** 清算（集金照合）を締める。差額≠0 はメモ必須・再清算は拒否。 */
export async function settleReservation(input: z.infer<typeof settleInput>): Promise<SettleActionResult> {
  const parsed = settleInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "入力を確認してください" };
  const g = await guard();
  if (!g.session) return { ok: false, error: g.error };
  const d = parsed.data;

  try {
    const sql = getClient();
    const out = await withUser(sql, g.session, (tx) =>
      settleReservationCore(tx, d.reservationId, d.collectedAmount, d.isCard, d.note, g.session!.userId, Date.now()),
    );
    if (out.kind === "note_required") return { ok: false, error: "差額があるときはメモ（理由）が必須です" };
    if (out.kind === "not_settleable") return { ok: false, error: "清算できません（退勤済みかつ未清算の予約のみ）" };
    revalidatePath(`/admin/reservations/${d.reservationId}`);
    return {
      ok: true,
      data: {
        totalAmount: out.data.totalAmount,
        collectedAmount: out.data.collectedAmount,
        diff: out.data.diff,
        reconciledAt: out.data.reconciledAt.toISOString(),
      },
    };
  } catch {
    return { ok: false, error: "清算に失敗しました" };
  }
}
