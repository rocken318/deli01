import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { EntityRecord } from "@/domain/cms";

/**
 * entity_records を entity + slug で取得する。
 *
 * entity_records は RLS で owner/admin のみ書き込み可、reception は読み取り可。
 * ただし現段階でフォームは管理画面用なので getDb() 直接読みで取得する。
 * （field_definitions と同じく管理画面の読み取りは withUser 不要）
 *
 * @returns 見つからない場合は null
 */
export async function getEntityRecord(
  entity: string,
  slug: string,
): Promise<EntityRecord | null> {
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.entityRecords)
    .where(
      and(
        eq(schema.entityRecords.entity, entity),
        eq(schema.entityRecords.slug, slug),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    entity: row.entity,
    slug: row.slug,
    draft: (row.draft as Record<string, unknown>) ?? {},
    published: (row.published as Record<string, unknown> | null) ?? null,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
