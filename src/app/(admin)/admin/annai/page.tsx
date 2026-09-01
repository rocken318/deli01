import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { listAnnaiBoardCore } from "@/lib/annai/queries";
import { buildBoard, type BoardRow, type AvailWindow, type JobItem } from "@/domain/annai";

export const dynamic = "force-dynamic";
const TZ = "Asia/Tokyo";
const hm = (d: Date) => formatInTimeZone(d, TZ, "HH:mm");
const hmMs = (ms: number) => formatInTimeZone(new Date(ms), TZ, "HH:mm");

const CHIP_WORKING = { label: "待機中", bg: "#3F7A6B", fg: "#fff" } as const;
const CHIP_RETIRED = { label: "上がり", bg: "#E7E9E7", fg: "#5b625f" } as const;

function centerText(w: AvailWindow): { big: string; sub: string } {
  if (w.kind === "now") return { big: "今すぐ", sub: w.untilMs ? `〜${hmMs(w.untilMs)}` : "上限なし" };
  if (w.kind === "from" && w.fromMs !== null)
    return { big: hmMs(w.fromMs), sub: w.untilMs ? `〜${hmMs(w.untilMs)}` : "上限なし" };
  return { big: "—", sub: "" };
}

function JobCard({ job, side }: { job: JobItem; side: "done" | "up" }) {
  const bg = side === "done" ? "#F3F7F5" : "#FBF3E6";
  const bd = side === "done" ? "#DFE3DE" : "#E9D9BC";
  return (
    <Link
      href={`/admin/reservations/${job.id}`}
      style={{
        flex: "0 0 auto",
        background: bg,
        border: `1px solid ${bd}`,
        borderRadius: 6,
        padding: "5px 9px",
        textDecoration: "none",
        color: "#1C2321",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700 }}>
        {hm(job.startAt)}
        {side === "done" ? `–${hm(job.endAt)}` : ""} ↗
      </div>
      <div style={{ fontSize: 10, color: side === "done" ? "#5b625f" : "#8a5d16" }}>
        {side === "done" ? `¥${job.totalAmount.toLocaleString()}` : `出発${hm(job.departAt)}`}
      </div>
    </Link>
  );
}

function Row({ r }: { r: BoardRow }) {
  const chip = r.attendanceState === "done" ? CHIP_RETIRED : CHIP_WORKING;
  const c = centerText(r.window);
  return (
    <div style={{ background: "#fff", border: "1px solid #DFE3DE", borderRadius: 8, padding: "10px 12px", marginBottom: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 156px 1fr", gap: 8, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", overflowX: "auto" }}>
          {r.done.map((j) => (
            <JobCard key={j.id} job={j} side="done" />
          ))}
        </div>
        <div style={{ background: "#EAF3EF", border: "2px solid #3F7A6B", borderRadius: 8, padding: 5, textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#3F7A6B", fontFamily: "'IBM Plex Mono',monospace", lineHeight: 1.05 }}>
            {c.big}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#C98A2B", fontFamily: "'IBM Plex Mono',monospace" }}>{c.sub}</div>
          {r.window.gapMin !== null && r.window.gapMin > 0 && (
            <div style={{ fontSize: 10, color: "#5b625f" }}>空き{r.window.gapMin}分</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-start", overflowX: "auto" }}>
          {r.upcoming.map((j) => (
            <JobCard key={j.id} job={j} side="up" />
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#9BA5AF", marginTop: 4 }}>
        <Link href={`/admin/therapists/${r.slug}`} style={{ color: "#3F7A6B", fontWeight: 700, fontSize: 13 }}>
          {r.name}
        </Link>{" "}
        <span style={{ background: chip.bg, color: chip.fg, padding: "1px 7px", borderRadius: 4, fontSize: 11 }}>{chip.label}</span>
        {r.lateManual && (
          <span style={{ background: "#C98A2B", color: "#fff", padding: "1px 7px", borderRadius: 4, fontSize: 11, marginLeft: 4 }}>遅刻</span>
        )}
      </div>
    </div>
  );
}

export default async function AnnaiPage() {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return <main style={{ padding: 24 }}>権限がありません。</main>;
  }
  const nowMs = Date.now();
  const sql = getClient();
  const rows = await withUser(sql, session, (tx) => listAnnaiBoardCore(tx, nowMs));
  const { active, retired } = buildBoard(rows, nowMs);

  return (
    <main style={{ padding: 24, background: "#F6F7F5", minHeight: "100vh" }}>
      <h1 style={{ color: "#1C2321", marginBottom: 4 }}>案内表</h1>
      <p style={{ color: "#5b625f", fontSize: 13, marginBottom: 12 }}>
        次案内可能が早い順（{formatInTimeZone(new Date(nowMs), TZ, "yyyy-MM-dd HH:mm")}）。名前=予定/売上、予約カード=詳細へ。
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 156px 1fr", gap: 8, marginBottom: 6, fontSize: 10, color: "#9BA5AF" }}>
        <div style={{ textAlign: "right", paddingRight: 4 }}>← 終わった仕事</div>
        <div style={{ textAlign: "center", color: "#2c6152", fontWeight: 700 }}>次案内可能（早い順↓）</div>
        <div style={{ paddingLeft: 4 }}>これからの仕事 →</div>
      </div>
      {active.map((r) => (
        <Row key={r.therapistId} r={r} />
      ))}
      {retired.length > 0 && (
        <>
          <div style={{ height: 5, background: "#404844", borderRadius: 3, margin: "10px 0 6px" }} />
          <div style={{ fontSize: 11, color: "#9BA5AF", fontWeight: 700, marginBottom: 6 }}>上がり</div>
          {retired.map((r) => (
            <Row key={r.therapistId} r={r} />
          ))}
        </>
      )}
      {active.length === 0 && retired.length === 0 && (
        <p style={{ color: "#9BA5AF" }}>本日の出勤・予約がありません。</p>
      )}
    </main>
  );
}
