import type { Metadata } from "next";
import { formatInTimeZone } from "date-fns-tz";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { listAnnaiBoardCore } from "@/lib/annai/queries";
import { operatingDayISO, APP_TIME_ZONE } from "@/domain/availability";
import { buildBoard } from "@/domain/annai";
import { getReservationList } from "@/lib/reservations/list-actions";
import { listHotelsLookup } from "@/lib/hotels/hotel-lookup-actions";
import ReservationListClient from "./ReservationListClient";

export const metadata: Metadata = { title: "予約一覧" };
export const dynamic = "force-dynamic";

const TZ = APP_TIME_ZONE;

interface TherapistRow {
  id: string;
  slug: string;
  display_name: string | null;
}
interface CourseRow {
  id: string;
  name: string;
  duration_min: number;
  price: number;
  nomination_fee_default: number;
}
interface OptionRow {
  id: string;
  name: string;
  price: number;
  duration_min: number;
}
interface AreaRow {
  id: string;
  name: string;
}

export interface TherapistAvailWindow {
  therapistId: string;
  name: string;
  kind: "now" | "from" | "off" | "done";
  fromLabel: string | null;
  untilLabel: string | null;
  gapMin: number | null;
  busyNow: boolean;
}

function hmMs(ms: number, opDay: string): string {
  const d = new Date(ms);
  const dateISO = formatInTimeZone(d, TZ, "yyyy-MM-dd");
  if (dateISO > opDay) {
    const h = Number(formatInTimeZone(d, TZ, "H"));
    return `${h + 24}:${formatInTimeZone(d, TZ, "mm")}`;
  }
  return formatInTimeZone(d, TZ, "HH:mm");
}

export default async function ReservationListPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_reservations")) {
    return <main style={{ padding: 24 }}>権限がありません。</main>;
  }

  const params = await searchParams;
  const nowMs = Date.now();
  const todayISO = formatInTimeZone(new Date(nowMs), TZ, "yyyy-MM-dd");
  const dateISO = params.date ?? todayISO;
  const opDay = operatingDayISO(new Date(nowMs));

  const sql = getClient();

  const [reservations, therapists, courses, options, areas, boardRows, hotelsResult] =
    await Promise.all([
      getReservationList(dateISO),
      sql<TherapistRow[]>`
        select t.id, t.slug,
               r.published->>'name' as display_name
        from therapists t
        left join entity_records r on r.entity = 'therapist' and r.slug = t.slug
        where t.status = 'active'
        order by t.display_order asc
      `,
      sql<CourseRow[]>`
        select id, name, duration_min, price, nomination_fee_default
        from courses where is_active = true
        order by sort_order asc, duration_min asc
      `,
      sql<OptionRow[]>`
        select id, name, price, duration_min
        from options where is_active = true and is_public = true
        order by sort_order asc
      `,
      sql<AreaRow[]>`select id, name from areas where is_active = true order by sort_order asc`,
      withUser(sql, session, (tx) => listAnnaiBoardCore(tx, nowMs)),
      listHotelsLookup(),
    ]);
  const hotels = hotelsResult.ok ? (hotelsResult.data ?? []) : [];

  // 案内表と同じロジックでセラピスト別の次案内可能ウィンドウを算出
  const { active, retired } = buildBoard(boardRows, nowMs);
  const allBoardRows = [...active, ...retired];

  const availWindows: TherapistAvailWindow[] = allBoardRows.map((r) => {
    const w = r.window;
    let fromLabel: string | null = null;
    let untilLabel: string | null = null;
    if (w.kind === "now") {
      fromLabel = "今すぐ";
      untilLabel = w.untilMs ? hmMs(w.untilMs, opDay) : null;
    } else if (w.kind === "from" && w.fromMs !== null) {
      fromLabel = hmMs(w.fromMs, opDay);
      untilLabel = w.untilMs ? hmMs(w.untilMs, opDay) : null;
    } else if (w.kind === "done") {
      fromLabel = "上がり";
    }
    return {
      therapistId: r.therapistId,
      name: r.name,
      kind: w.kind,
      fromLabel,
      untilLabel,
      gapMin: w.gapMin,
      busyNow: w.busyNow,
    };
  });

  return (
    <ReservationListClient
      dateISO={dateISO}
      todayISO={todayISO}
      reservations={reservations}
      therapists={therapists.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.display_name ?? t.slug,
      }))}
      courses={courses}
      options={options}
      areas={areas}
      availWindows={availWindows}
      hotels={hotels}
    />
  );
}
