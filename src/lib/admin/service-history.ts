import "server-only";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";

/**
 * 接客履歴（完了した予約）の管理側一覧。owner/admin は全セラピスト分を見られる。
 * （セラピスト本人の「自分だけ」は /mypage 側の getMyServiceHistory が担う。RLS で本人限定）
 */

export interface ServiceHistoryRow {
  reservationId: string;
  dateISO: string;
  startHHmm: string;
  therapistSlug: string;
  therapistName: string;
  customerName: string | null;
  courseName: string;
  areaName: string | null;
  totalAmount: number;
}

export interface ServiceHistoryResult {
  rows: ServiceHistoryRow[];
  total: number;
}

export type ServiceHistoryOutcome =
  | { kind: "ok"; data: ServiceHistoryResult }
  | { kind: "forbidden" };

export async function getServiceHistoryAdmin(params: {
  therapistSlug?: string;
  limit?: number;
  offset?: number;
}): Promise<ServiceHistoryOutcome> {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_reservations")) {
    return { kind: "forbidden" };
  }
  const limit = Math.min(Math.max(1, params.limit ?? 50), 200);
  const offset = Math.max(0, params.offset ?? 0);
  const slug = params.therapistSlug && /^[a-z0-9-]+$/.test(params.therapistSlug)
    ? params.therapistSlug
    : null;

  const sql = getClient();
  return withUser<ServiceHistoryOutcome>(sql, session, async (tx) => {
    const filter = slug ? tx`and t.slug = ${slug}` : tx``;

    const countRows = await tx<{ n: number }[]>`
      select count(*)::int as n
      from reservations r
      join therapists t on t.id = r.therapist_id
      where r.status = 'done' ${filter}
    `;

    const rows = await tx<
      {
        id: string;
        start_at: Date;
        slug: string;
        therapist_name: string | null;
        customer_name: string | null;
        course_name: string;
        area_name: string | null;
        total_amount: number;
      }[]
    >`
      select r.id, r.start_at, t.slug,
             er.published->>'name' as therapist_name,
             c.name as customer_name,
             co.name as course_name,
             ar.name as area_name,
             r.total_amount
      from reservations r
      join therapists t on t.id = r.therapist_id
      left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
      join courses co on co.id = r.course_id
      left join areas ar on ar.id = r.area_id
      left join customers c on c.id = r.customer_id
      where r.status = 'done' ${filter}
      order by r.start_at desc
      limit ${limit} offset ${offset}
    `;

    const { formatInTimeZone } = await import("date-fns-tz");
    return {
      kind: "ok",
      data: {
        total: countRows[0]!.n,
        rows: rows.map((r) => ({
          reservationId: r.id,
          dateISO: formatInTimeZone(r.start_at, "Asia/Tokyo", "yyyy-MM-dd"),
          startHHmm: formatInTimeZone(r.start_at, "Asia/Tokyo", "HH:mm"),
          therapistSlug: r.slug,
          therapistName: r.therapist_name ?? r.slug,
          customerName: r.customer_name,
          courseName: r.course_name,
          areaName: r.area_name,
          totalAmount: r.total_amount,
        })),
      },
    };
  });
}
