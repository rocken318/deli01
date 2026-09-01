import { formatInTimeZone } from "date-fns-tz";
import { compareShiftVsAttendance } from "@/domain/attendance";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { listTodayDiffCore } from "@/lib/attendance/queries";

export const dynamic = "force-dynamic";

const TZ = "Asia/Tokyo";
const hm = (d: Date | null) => (d ? formatInTimeZone(d, TZ, "HH:mm") : "—");

const LABEL_COLOR: Record<string, string> = {
  遅刻: "#C98A2B",
  早退: "#C98A2B",
  未打刻: "#B4453C",
  予定外出勤: "#3F7A6B",
  退勤済: "#5b625f",
  予定通り: "#2c6152",
  対象外: "#9BA5AF",
};

export default async function AdminAttendancePage() {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return <main style={{ padding: 24 }}>権限がありません。</main>;
  }

  const now = Date.now();
  const sql = getClient();
  const rows = await withUser(sql, session, (tx) => listTodayDiffCore(tx, now));

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: "#1C2321", marginBottom: 4 }}>出退勤（当日）</h1>
      <p style={{ color: "#5b625f", fontSize: 13, marginBottom: 16 }}>
        予定と実績の差分。稼働の可視化が目的です（
        {formatInTimeZone(new Date(now), TZ, "yyyy-MM-dd")}）。
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#EEF1EF", textAlign: "left" }}>
            <th style={{ padding: 8 }}>女性</th>
            <th>予定</th>
            <th>出勤</th>
            <th>退勤</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const plan =
              r.planStartAt && r.planEndAt
                ? { startAt: r.planStartAt, endAt: r.planEndAt }
                : null;
            const actual = { clockInAt: r.clockInAt, clockOutAt: r.clockOutAt };
            const d = compareShiftVsAttendance(plan, actual, now);
            const extra =
              d.label === "遅刻"
                ? `（${d.lateMin}分）`
                : d.label === "早退"
                  ? `（${d.earlyMin}分）`
                  : "";
            return (
              <tr
                key={r.therapistId}
                style={{ borderTop: "1px solid #DFE3DE", background: "#fff" }}
              >
                <td style={{ padding: 8 }}>{r.name}</td>
                <td>{plan ? `${hm(r.planStartAt)}–${hm(r.planEndAt)}` : "—"}</td>
                <td>{hm(r.clockInAt)}</td>
                <td>{hm(r.clockOutAt)}</td>
                <td style={{ color: LABEL_COLOR[d.label] ?? "#1C2321", fontWeight: 700 }}>
                  {d.label}
                  {extra}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
