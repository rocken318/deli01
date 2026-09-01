"use server";

/**
 * QR出退勤の Server Actions（フェーズD / spec 3-5）。
 * - issueKioskToken: owner/admin のみ。短命署名トークン＋QR(SVG) を返す。
 * - punchAttendanceAction: therapist のみ。トークン再検証 → 本人の打刻（冪等）。
 * 位置情報は扱わない。制裁機能は作らない（可視化のみ）。
 */

import { headers } from "next/headers";
import { z } from "zod";
import { toString as qrToString } from "qrcode";
import { can } from "@/domain/auth";
import { signToken, verifyToken, nextPunchAction } from "@/domain/attendance";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { toActor } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { getDevSession, getTherapistDevSession } from "@/lib/cms/dev-session";
import { getTodayAttendanceCore, punchAttendanceCore } from "@/lib/attendance/queries";

export interface KioskTokenResult {
  ok: boolean;
  token?: string;
  svg?: string;
  reason?: string;
}

async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

/** キオスク用トークン＋QR(SVG)。QR の中身は <origin>/mypage/punch?t=<token>。 */
export async function issueKioskToken(): Promise<KioskTokenResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, reason: "unauthenticated" };
  if (!can(toActor(session), "manage_cms")) return { ok: false, reason: "forbidden" };

  const secret = env.attendanceQrSecret;
  if (!secret) return { ok: false, reason: "no_secret" };

  const token = signToken(secret, Date.now());
  const base = await requestOrigin();
  const url = `${base}/mypage/punch?t=${encodeURIComponent(token)}`;
  const svg = await qrToString(url, { type: "svg", margin: 1, width: 320 });
  return { ok: true, token, svg };
}

const punchInput = z.object({
  token: z.string().min(1),
  asSlug: z.string().optional(), // dev なりすまし（本番は無視される）
});

export interface PunchResult {
  ok: boolean;
  action?: "clock_in" | "clock_out" | "none";
  at?: string; // ISO
  reason?: "invalid_token" | "expired" | "no_secret" | "unauthenticated" | "already_done";
}

export async function punchAttendanceAction(
  input: z.infer<typeof punchInput>,
): Promise<PunchResult> {
  const { token, asSlug } = punchInput.parse(input);

  const secret = env.attendanceQrSecret;
  if (!secret) return { ok: false, reason: "no_secret" };

  const check = verifyToken(secret, token, Date.now());
  if (!check.ok) {
    return { ok: false, reason: check.reason === "expired" ? "expired" : "invalid_token" };
  }

  const session = await getTherapistDevSession(asSlug);
  if (!session) return { ok: false, reason: "unauthenticated" };

  const sql = getClient();
  return withUser(sql, session, async (tx) => {
    const who = await tx<{ therapist_id: string | null }[]>`
      select therapist_id from app_users where id = ${session.userId} limit 1
    `;
    const therapistId = who[0]?.therapist_id;
    if (!therapistId) return { ok: false, reason: "unauthenticated" as const };

    const now = Date.now();
    const current = await getTodayAttendanceCore(tx, therapistId, now);
    const action = nextPunchAction(
      current ? { clockInAt: current.clockInAt, clockOutAt: current.clockOutAt } : null,
    );
    if (action === "none") return { ok: false, reason: "already_done" as const };

    const rec = await punchAttendanceCore(tx, therapistId, action, now);
    const at = action === "clock_in" ? rec.clockInAt : rec.clockOutAt;
    return { ok: true, action, at: at ? at.toISOString() : undefined };
  });
}
