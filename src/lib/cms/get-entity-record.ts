import "server-only";
import type { Session } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import type { EntityRecord } from "@/domain/cms";

/**
 * entity_records を entity + slug で取得する。
 *
 * entity_records は RLS 対象（owner/admin 全操作・reception select・therapist 不可）。
 * 接続ユーザーは BYPASSRLS なので、必ず withUser() 経由（= app_runtime に降格）で読み、
 * RLS を実効化する（docs/auth-rls.md §1）。field_definitions（全員 select 可）と違い
 * getDb() 直読みはしない。
 *
 * @returns 見つからない / 権限なしの場合は null
 */
export async function getEntityRecord(
  session: Session,
  entity: string,
  slug: string,
): Promise<EntityRecord | null> {
  const sql = getClient();

  return withUser(sql, session, async (tx) => {
    const rows = await tx<
      {
        id: string;
        entity: string;
        slug: string;
        draft: Record<string, unknown> | null;
        published: Record<string, unknown> | null;
        published_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }[]
    >`
      select id, entity, slug, draft, published, published_at, created_at, updated_at
      from entity_records
      where entity = ${entity} and slug = ${slug}
      limit 1
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      entity: row.entity,
      slug: row.slug,
      draft: row.draft ?? {},
      published: row.published ?? null,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}
