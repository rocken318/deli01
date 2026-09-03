import "server-only";
import { getClient } from "@/lib/db-client";

/**
 * 顧客マイページ（マジックリンク / 0027）。トークンで本人の要約だけを読む。
 * 認証はトークンそのもの（推測困難な uuid）＝リンクを知る本人のみ。
 * 実体は security definer 関数 customer_portal_summary で RLS をバイパスしつつ
 * where portal_token で厳格にスコープする（他人の行は返らない）。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CustomerPortalHistory {
  date: string;
  therapist: string;
  therapistSlug: string | null;
  course: string | null;
  status: string;
}
export interface CustomerPortal {
  name: string;
  points: number;
  history: CustomerPortalHistory[];
}

export async function getCustomerPortal(token: string): Promise<CustomerPortal | null> {
  if (!UUID_RE.test(token)) return null;
  const sql = getClient();
  const rows = await sql<{ summary: CustomerPortal | null }[]>`
    select customer_portal_summary(${token}::uuid) as summary
  `;
  return rows[0]?.summary ?? null;
}
