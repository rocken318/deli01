import { verifyToken, nextPunchAction } from "@/domain/attendance";
import { env } from "@/lib/env";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { getTherapistDevSession } from "@/lib/cms/dev-session";
import { getTodayAttendanceCore } from "@/lib/attendance/queries";
import PunchButton from "./PunchButton";

export const dynamic = "force-dynamic";

export default async function PunchPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; as?: string }>;
}) {
  const { t, as } = await searchParams;
  const wrap = (msg: string, tone: "err" | "ok" = "err") => (
    <main style={{ padding: 24, maxWidth: 420, margin: "0 auto" }}>
      <p style={{ color: tone === "err" ? "#B4453C" : "#2c6152", fontSize: 16 }}>{msg}</p>
    </main>
  );

  const secret = env.attendanceQrSecret;
  if (!secret) return wrap("打刻は現在利用できません（設定未完了）。");
  if (!t) return wrap("QRから開いてください。");
  const check = verifyToken(secret, t, Date.now());
  if (!check.ok) {
    return wrap(
      check.reason === "expired"
        ? "QRの有効期限が切れました。事務所の画面を撮り直してください。"
        : "QRが不正です。",
    );
  }

  const session = await getTherapistDevSession(as);
  if (!session) return wrap("ログインが必要です。");

  const sql = getClient();
  const { name, action } = await withUser(sql, session, async (tx) => {
    const who = await tx<{ therapist_id: string | null; display_name: string | null }[]>`
      select therapist_id, display_name from app_users where id = ${session.userId} limit 1
    `;
    const therapistId = who[0]?.therapist_id ?? null;
    if (!therapistId) return { name: null as string | null, action: "none" as const };
    const cur = await getTodayAttendanceCore(tx, therapistId, Date.now());
    return {
      name: who[0]?.display_name ?? null,
      action: nextPunchAction(
        cur ? { clockInAt: cur.clockInAt, clockOutAt: cur.clockOutAt } : null,
      ),
    };
  });

  if (!name) return wrap("セラピストアカウントが見つかりません。");
  if (action === "none") return wrap("本日はすでに退勤済みです。おつかれさまでした。", "ok");

  return (
    <main style={{ padding: 24, maxWidth: 420, margin: "0 auto" }}>
      <p style={{ color: "#1C2321", fontSize: 15, marginBottom: 4 }}>{name} さん</p>
      <p style={{ color: "#5b625f", fontSize: 13, marginBottom: 20 }}>
        {action === "clock_in" ? "出勤を打刻します" : "退勤を打刻します"}
      </p>
      <PunchButton token={t} asSlug={as} action={action} />
    </main>
  );
}
