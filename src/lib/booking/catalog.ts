import "server-only";
import { getClient } from "@/lib/db-client";

/**
 * 注文フローの派遣先候補（フェーズ11 / spec 6章 手順2・8-2）。
 * is_blocked（入館お断り）のホテルは公開側で選べない。
 */

export interface BookableHotel {
  id: string;
  name: string;
}

export async function listBookableHotels(): Promise<BookableHotel[]> {
  const sql = getClient();
  const rows = await sql<{ id: string; name: string }[]>`
    select id, name
    from hotels
    where is_blocked = false
    order by name asc
  `;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}
