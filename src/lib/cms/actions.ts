"use server";

/**
 * CMS フィールド管理の Server Actions（spec 3-1）。
 *
 * - 全アクションは owner/admin のみ実行可能（can(actor, 'manage_cms')）
 * - 全アクションは audit_logs に記録する
 * - withUser() 経由で RLS を有効にして実行する
 * - key と type は変更不可（spec 3-1: key の変更は禁止）
 * - 論理削除は deleted_at を set / clear する
 */

import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import type { AddFieldInput, UpdateFieldInput } from "@/domain/cms";
import { FIELD_TYPES } from "@/domain/cms";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";

/** Server Action の共通レスポンス型 */
export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// 入力バリデーションスキーマ
// ---------------------------------------------------------------------------

const addFieldSchema = z.object({
  entity: z.string().min(1),
  key: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, "key は小文字英数字とアンダースコアのみ使用可"),
  label: z.string().min(1),
  type: z.enum(FIELD_TYPES as [string, ...string[]]),
  options: z
    .object({
      choices: z.array(z.string()).optional(),
      min: z.number().int().optional(),
      max: z.number().int().optional(),
    })
    .optional(),
  groupLabel: z.string().optional(),
  sortOrder: z.number().int().default(0),
  isPublic: z.boolean().default(false),
  isRequired: z.boolean().default(false),
  isFilterable: z.boolean().default(false),
  helpText: z.string().optional(),
});

const updateFieldSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).optional(),
  options: z
    .object({
      choices: z.array(z.string()).optional(),
      min: z.number().int().optional(),
      max: z.number().int().optional(),
    })
    .optional(),
  groupLabel: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  isPublic: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  isFilterable: z.boolean().optional(),
  helpText: z.string().nullable().optional(),
});

const reorderSchema = z.array(
  z.object({
    id: z.string().uuid(),
    sortOrder: z.number().int(),
  }),
);

const saveRecordSchema = z.object({
  entity: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug は小文字英数字とハイフンのみ"),
  draft: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// フィールド定義: 追加
// ---------------------------------------------------------------------------

/**
 * フィールド定義を追加する（owner/admin のみ）。
 * key は追加時のみ指定可能。以降の変更は禁止（spec 3-1）。
 */
export async function addFieldDefinition(
  input: AddFieldInput,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = addFieldSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const data = parsed.data;
  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      // insert
      const rows = await tx<{ id: string }[]>`
        insert into field_definitions
          (entity, key, label, type, options, group_label, sort_order,
           is_public, is_required, is_filterable, help_text)
        values (
          ${data.entity},
          ${data.key},
          ${data.label},
          ${data.type}::field_type,
          ${data.options != null ? JSON.stringify(data.options) : null}::jsonb,
          ${data.groupLabel ?? null},
          ${data.sortOrder},
          ${data.isPublic},
          ${data.isRequired},
          ${data.isFilterable},
          ${data.helpText ?? null}
        )
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error("insert failed");

      // audit_logs
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid,
          'create',
          'field_definition',
          ${row.id}::uuid,
          ${JSON.stringify({ entity: data.entity, key: data.key, label: data.label })}::jsonb
        )
      `;

      return { id: row.id };
    });

    return { ok: true, data: result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    // 一意制約違反（同一 entity + key）
    if (msg.includes("field_definitions_entity_key_unique")) {
      return { ok: false, error: `entity '${data.entity}' に key '${data.key}' は既に存在します` };
    }
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// フィールド定義: 更新（label / options / sort_order 等。key・type は不可）
// ---------------------------------------------------------------------------

/**
 * フィールド定義のラベル・並び順・表示設定を更新する（owner/admin のみ）。
 * key と type は変更不可（spec 3-1）。
 */
export async function updateFieldDefinition(
  input: UpdateFieldInput,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = updateFieldSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const data = parsed.data;
  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      // 既存レコードを取得（before スナップショット）
      const existing = await tx<{ id: string; label: string; sort_order: number }[]>`
        select id, label, sort_order from field_definitions where id = ${data.id}::uuid
      `;
      const before = existing[0];
      if (!before) throw new Error("フィールド定義が見つかりません");

      // 更新（key / type は SET に含めない）
      await tx`
        update field_definitions
        set
          label       = coalesce(${data.label ?? null}, label),
          options     = coalesce(${data.options != null ? JSON.stringify(data.options) : null}::jsonb, options),
          group_label = ${data.groupLabel !== undefined ? data.groupLabel : null}::text,
          sort_order  = coalesce(${data.sortOrder ?? null}, sort_order),
          is_public   = coalesce(${data.isPublic ?? null}, is_public),
          is_required = coalesce(${data.isRequired ?? null}, is_required),
          is_filterable = coalesce(${data.isFilterable ?? null}, is_filterable),
          help_text   = ${data.helpText !== undefined ? data.helpText : null}::text
        where id = ${data.id}::uuid
      `;

      // audit_logs
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, before, after)
        values (
          ${session.userId}::uuid,
          'update',
          'field_definition',
          ${data.id}::uuid,
          ${JSON.stringify(before)}::jsonb,
          ${JSON.stringify(data)}::jsonb
        )
      `;
    });

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// フィールド定義: 論理削除（非表示）/ 復元
// ---------------------------------------------------------------------------

/**
 * フィールドを論理削除（deleted_at をセット）または復元（null に戻す）する。
 * 既存データは jsonb カラムに残るため、巻き添え削除しない（spec 3-1）。
 */
export async function toggleFieldVisibility(
  id: string,
  hide: boolean,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) return { ok: false, error: "無効な ID です" };

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      if (hide) {
        await tx`
          update field_definitions
          set deleted_at = now()
          where id = ${id}::uuid
        `;
      } else {
        await tx`
          update field_definitions
          set deleted_at = null
          where id = ${id}::uuid
        `;
      }

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid,
          ${hide ? "soft_delete" : "restore"},
          'field_definition',
          ${id}::uuid,
          ${JSON.stringify({ hide })}::jsonb
        )
      `;
    });

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// フィールド定義: 並べ替え
// ---------------------------------------------------------------------------

/**
 * 複数フィールドの sort_order を一括更新する（owner/admin のみ）。
 */
export async function reorderFieldDefinitions(
  items: { id: string; sortOrder: number }[],
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = reorderSchema.safeParse(items);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      for (const item of parsed.data) {
        await tx`
          update field_definitions
          set sort_order = ${item.sortOrder}
          where id = ${item.id}::uuid
        `;
      }

      await tx`
        insert into audit_logs (actor_user_id, action, entity, after)
        values (
          ${session.userId}::uuid,
          'reorder',
          'field_definition',
          ${JSON.stringify(parsed.data)}::jsonb
        )
      `;
    });

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// entity_records: draft の保存
// ---------------------------------------------------------------------------

/**
 * entity_records の draft を保存する（upsert）。
 * owner/admin のみ（RLS でも enforcement）。
 */
export async function saveEntityRecord(
  entity: string,
  slug: string,
  draft: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = saveRecordSchema.safeParse({ entity, slug, draft });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into entity_records (entity, slug, draft)
        values (
          ${parsed.data.entity},
          ${parsed.data.slug},
          ${JSON.stringify(parsed.data.draft)}::jsonb
        )
        on conflict (entity, slug)
        do update set
          draft      = excluded.draft,
          updated_at = now()
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error("upsert failed");

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid,
          'update',
          'entity_record',
          ${row.id}::uuid,
          ${JSON.stringify({ entity: parsed.data.entity, slug: parsed.data.slug })}::jsonb
        )
      `;

      return { id: row.id };
    });

    return { ok: true, data: result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// entity_records: 公開
// ---------------------------------------------------------------------------

/**
 * entity_records の draft を published にコピーし公開する（owner/admin のみ）。
 */
export async function publishEntityRecord(
  entity: string,
  slug: string,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const sql = getClient();

  try {
    await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update entity_records
        set published = draft, published_at = now()
        where entity = ${entity} and slug = ${slug}
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error("レコードが見つかりません");

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id)
        values (
          ${session.userId}::uuid,
          'publish',
          'entity_record',
          ${row.id}::uuid
        )
      `;
    });

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}
