import "server-only";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

/**
 * 表ページ（公開トップ）に出るセラピストの並び順管理用データ。
 *
 * 公開トップは「公開中(published)・稼働中(active)」のセラピストを display_order 順で
 * カード表示する（src/app/(public)/page.tsx）。ここではその同じ集合を管理側で並べ替える
 * ために、名前と display_order を返す。「すぐ迎える」最短案内時刻は呼び出し側（page）が
 * 空き枠エンジンで best-effort に付ける。
 */

export interface LineupItem {
  id: string;
  slug: string;
  name: string;
  displayOrder: number;
}

/** 公開トップに出る順（display_order 昇順）でセラピストを返す。owner/admin。 */
export async function getFrontLineup(
  session: Session,
): Promise<LineupItem[]> {
  const sql = getClient();
  return withUser(sql, session, async (tx) => {
    const rows = await tx<{
      id: string;
      slug: string;
      name: string;
      display_order: number;
    }[]>`
      select t.id, t.slug,
             coalesce(er.published ->> 'name', t.slug) as name,
             t.display_order
      from therapists t
      join entity_records er
        on er.entity = 'therapist' and er.slug = t.slug
      where t.status = 'active' and er.published is not null
      order by t.display_order asc, t.created_at asc
    `;
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      displayOrder: r.display_order,
    }));
  });
}
