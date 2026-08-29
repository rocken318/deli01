import "server-only";
import { asc, eq, isNull, and } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { FieldDefinition } from "@/domain/cms";

/**
 * entity の field_definitions を取得する（論理削除済みを除く）。
 *
 * field_definitions は RLS で「全員 select 可」（0001_auth.sql）なので、
 * withUser を通さず getDb() で直接読む。
 * sort_order → group_label の順で並べる。
 *
 * @param entity - 'therapist' | 'course' | 'area' | 'page' など
 */
export async function getFieldDefinitions(entity: string): Promise<FieldDefinition[]> {
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.fieldDefinitions)
    .where(
      and(
        eq(schema.fieldDefinitions.entity, entity),
        isNull(schema.fieldDefinitions.deletedAt),
      ),
    )
    .orderBy(
      asc(schema.fieldDefinitions.sortOrder),
      asc(schema.fieldDefinitions.groupLabel),
    );

  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    key: r.key,
    label: r.label,
    type: r.type,
    options: (r.options as { choices?: string[]; min?: number; max?: number } | null) ?? null,
    groupLabel: r.groupLabel,
    sortOrder: r.sortOrder,
    isPublic: r.isPublic,
    isRequired: r.isRequired,
    isFilterable: r.isFilterable,
    helpText: r.helpText,
    deletedAt: r.deletedAt,
    createdAt: r.createdAt,
  }));
}
