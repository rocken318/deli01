import "server-only";
import type { Sql } from "postgres";
import type { Session } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";

/**
 * ブランド（店舗ブランド）の参照（設計 4.1）。
 * 現状は「王様の休日」1件。将来の複数ブランド化の下地。
 * RLS: 参照は owner/admin/reception/therapist（0030）。
 */
export interface BrandRow {
  id: string;
  name: string;
  shortName: string;
  sortOrder: number;
  isActive: boolean;
}

/** アクティブなブランドを sort_order 昇順で返す。 */
export async function listBrandsCore(sql: Sql, session: Session): Promise<BrandRow[]> {
  const rows = await withUser(sql, session, async (tx) => {
    return tx<
      {
        id: string;
        name: string;
        short_name: string;
        sort_order: number;
        is_active: boolean;
      }[]
    >`
      select id, name, short_name, sort_order, is_active
      from brands
      where is_active = true
      order by sort_order asc, name asc
    `;
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    sortOrder: r.sort_order,
    isActive: r.is_active,
  }));
}
