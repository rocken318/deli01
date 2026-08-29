"use server";

/**
 * セラピスト管理の Server Actions（spec 3-7・3-8・4章）。
 *
 * - publishTherapistProfile: 掲載同意ゲート付きの公開アクション
 * - retireTherapist: 退職処理（ステータス変更 + 一括非公開）
 *
 * STRICT: jsonb 値は tx.json() を使う。JSON.stringify + ::jsonb は禁止。
 */

import { z } from "zod";
import { can } from "@/domain/auth";
import { buildZodSchema } from "@/domain/cms";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import { getFieldDefinitions } from "@/lib/cms/get-field-definitions";
import type { ActionResult } from "@/lib/cms/actions";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

interface MediaRow {
  id: string;
  alt: string;
  consent_flag: boolean;
}

interface EntityRecordRow {
  id: string;
  draft: Record<string, unknown>;
}

interface FieldDefRow {
  key: string;
  type: string;
}

// ---------------------------------------------------------------------------
// 内部ヘルパ: draft から image/image_gallery フィールドの media id を抽出
// ---------------------------------------------------------------------------

/**
 * draft JSONB から image / image_gallery フィールドに入っている media ID を返す。
 * image フィールドは string（単一 UUID）、image_gallery は string[]。
 * 無効値や空は除外する。
 */
function extractMediaIds(
  draft: Record<string, unknown>,
  imageFieldKeys: string[],
): string[] {
  const ids: string[] = [];
  for (const key of imageFieldKeys) {
    const val = draft[key];
    if (typeof val === "string" && val.length > 0) {
      ids.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.length > 0) {
          ids.push(item);
        }
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// publishTherapistProfile
// ---------------------------------------------------------------------------

const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, "slug は小文字英数字とハイフンのみ");

/**
 * セラピストプロフィールを公開する（掲載同意ゲートつき）。
 *
 * 1. entity_records(entity='therapist', slug) の draft を取得
 * 2. field_definitions で type が image / image_gallery のキーを特定
 * 3. draft から media ID を抽出
 * 4. media を取得し、consent_flag=false のものがあれば公開ブロック
 * 5. 全件同意済みなら draft → published へコピー + audit_logs
 */
export async function publishTherapistProfile(slug: string): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsedSlug = slugSchema.safeParse(slug);
  if (!parsedSlug.success) {
    return { ok: false, error: parsedSlug.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    return await withUser(sql, session, async (tx): Promise<ActionResult> => {
      // 1. entity_records の draft を取得
      const recRows = await tx<EntityRecordRow[]>`
        select id, draft
        from entity_records
        where entity = 'therapist' and slug = ${slug}
        limit 1
      `;
      const rec = recRows[0];
      if (!rec) {
        return { ok: false, error: "セラピストのレコードが見つかりません" };
      }

      // 1.5 公開前に、定義から組んだ Zod で draft を検証する（fail-fast / spec 3-1・3-2）。
      // 必須項目が欠けている等は同意チェックより前に弾き、不完全な内容を公開させない。
      const defs = await getFieldDefinitions("therapist");
      const check = buildZodSchema(defs).safeParse(rec.draft);
      if (!check.success) {
        return {
          ok: false,
          error:
            "下書きに未入力/不正な項目があるため公開できません: " +
            check.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
        };
      }

      // 2. image / image_gallery フィールドのキーを取得
      // Rec 1: deleted_at is null フィルタは付けない。論理削除された image フィールドでも
      // draft に値が残っていれば published にコピーされうるため、同意チェックの対象に含める。
      const fieldRows = await tx<FieldDefRow[]>`
        select key, type
        from field_definitions
        where entity = 'therapist'
          and type in ('image', 'image_gallery')
      `;
      const imageFieldKeys = fieldRows.map((f) => f.key);

      // 3. draft から media ID を抽出
      const mediaIds = extractMediaIds(rec.draft, imageFieldKeys);

      // 4. 同意チェック
      if (mediaIds.length > 0) {
        const mediaRows = await tx<MediaRow[]>`
          select id, alt, consent_flag
          from media
          where id = any(${mediaIds}::uuid[])
        `;

        const unconsented = mediaRows.filter((m) => !m.consent_flag);
        if (unconsented.length > 0) {
          const fileList = unconsented.map((m) => m.alt).join("、");
          return {
            ok: false,
            error: `掲載同意の無い写真が含まれるため公開できません（対象: ${fileList}）`,
          };
        }
      }

      // 5. draft → published へコピー
      const updateRows = await tx<{ id: string }[]>`
        update entity_records
        set published = draft, published_at = now()
        where entity = 'therapist' and slug = ${slug}
        returning id
      `;
      const updated = updateRows[0];
      if (!updated) {
        throw new Error("公開処理に失敗しました");
      }

      // audit_logs
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid,
          'publish',
          'entity_record',
          ${updated.id}::uuid,
          ${tx.json({ entity: "therapist", slug })}
        )
      `;

      return { ok: true };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// retireTherapist
// ---------------------------------------------------------------------------

/**
 * セラピストを退職処理する。
 *
 * 1件のトランザクション内で以下をすべて実行する:
 * 1. therapists.status = 'retired', retired_at = now()（slug で特定）
 * 2. entity_records.published = null（プロフィール非公開）
 * 3. 関連 media.is_hidden = true（一括）
 */
export async function retireTherapist(slug: string): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsedSlug = slugSchema.safeParse(slug);
  if (!parsedSlug.success) {
    return { ok: false, error: parsedSlug.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    return await withUser(sql, session, async (tx): Promise<ActionResult> => {
      // 1. therapists.status を 'retired' に更新
      const therapistRows = await tx<{ id: string }[]>`
        update therapists
        set status = 'retired', retired_at = now()
        where slug = ${slug}
        returning id
      `;
      const therapist = therapistRows[0];
      if (!therapist) {
        return { ok: false, error: "セラピストが見つかりません" };
      }

      // 2. media 非公開化のため、published を null 化する前に draft/published を読む。
      // Rec 2: draft だけでなく published 側の画像参照も走査する。
      // 公開後に draft から写真を外したケースでも、公開中の写真を確実に非公開化するため。
      const recRows = await tx<{
        draft: Record<string, unknown>;
        published: Record<string, unknown> | null;
      }[]>`
        select draft, published
        from entity_records
        where entity = 'therapist' and slug = ${slug}
        limit 1
      `;
      const rec = recRows[0];

      // 3. entity_records.published を null に（プロフィール非公開）
      await tx`
        update entity_records
        set published = null, published_at = null
        where entity = 'therapist' and slug = ${slug}
      `;

      // 4. 関連 media を一括で is_hidden = true に
      if (rec) {
        const fieldRows = await tx<FieldDefRow[]>`
          select key, type
          from field_definitions
          where entity = 'therapist'
            and type in ('image', 'image_gallery')
        `;
        const imageFieldKeys = fieldRows.map((f) => f.key);
        const draftMediaIds = extractMediaIds(rec.draft, imageFieldKeys);
        const publishedMediaIds = rec.published
          ? extractMediaIds(rec.published, imageFieldKeys)
          : [];
        // draft・published 両側の参照を重複なくまとめる
        const mediaIds = Array.from(new Set([...draftMediaIds, ...publishedMediaIds]));

        if (mediaIds.length > 0) {
          await tx`
            update media
            set is_hidden = true
            where id = any(${mediaIds}::uuid[])
          `;
        }
      }

      // audit_logs
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid,
          'retire',
          'therapist',
          ${therapist.id}::uuid,
          ${tx.json({ slug, status: "retired" })}
        )
      `;

      return { ok: true };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// updateTherapistOrder
// ---------------------------------------------------------------------------

const reorderItemSchema = z.object({
  id: z.string().uuid(),
  displayOrder: z.number().int(),
});

const reorderSchema = z.array(reorderItemSchema);

/**
 * セラピストの表示順を一括更新する（owner/admin のみ）。
 */
export async function updateTherapistOrder(
  items: { id: string; displayOrder: number }[],
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
          update therapists
          set display_order = ${item.displayOrder}
          where id = ${item.id}::uuid
        `;
      }

      await tx`
        insert into audit_logs (actor_user_id, action, entity, after)
        values (
          ${session.userId}::uuid,
          'reorder',
          'therapist',
          ${tx.json(parsed.data)}
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
// upsertTherapist
// ---------------------------------------------------------------------------

const upsertTherapistSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug は小文字英数字とハイフンのみ"),
  status: z.enum(["active", "inactive", "retired"]).default("active"),
  displayOrder: z.number().int().default(0),
  appUserId: z.string().uuid().nullable().optional(),
});

export type UpsertTherapistInput = z.infer<typeof upsertTherapistSchema>;

/**
 * セラピストを作成または更新する（owner/admin のみ）。
 */
export async function upsertTherapist(
  input: UpsertTherapistInput,
): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "この操作には owner または admin のロールが必要です" };
  }

  const parsed = upsertTherapistSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const data = parsed.data;
  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into therapists (slug, status, display_order, app_user_id)
        values (
          ${data.slug},
          ${data.status}::therapist_status,
          ${data.displayOrder},
          ${data.appUserId ?? null}
        )
        on conflict (slug) do update set
          status        = excluded.status,
          display_order = excluded.display_order,
          app_user_id   = excluded.app_user_id,
          updated_at    = now()
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error("upsert failed");

      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (
          ${session.userId}::uuid,
          'upsert',
          'therapist',
          ${row.id}::uuid,
          ${tx.json({ slug: data.slug, status: data.status })}
        )
      `;

      return { id: row.id };
    });

    return { ok: true, data: result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return { ok: false, error: `slug '${data.slug}' は既に存在します` };
    }
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// listTherapists（管理画面一覧用）
// ---------------------------------------------------------------------------

export interface TherapistListItem {
  id: string;
  slug: string;
  status: "active" | "inactive" | "retired";
  displayOrder: number;
  appUserId: string | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * セラピスト一覧を display_order 順で返す。
 */
export async function listTherapists(): Promise<TherapistListItem[]> {
  const session = await getDevSession();
  if (!session) return [];

  const sql = getClient();

  return withUser(sql, session, async (tx) => {
    const rows = await tx<{
      id: string;
      slug: string;
      status: string;
      display_order: number;
      app_user_id: string | null;
      retired_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }[]>`
      select id, slug, status, display_order, app_user_id, retired_at, created_at, updated_at
      from therapists
      order by display_order asc, created_at asc
    `;

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      status: r.status as "active" | "inactive" | "retired",
      displayOrder: r.display_order,
      appUserId: r.app_user_id,
      retiredAt: r.retired_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  });
}

/**
 * slug からセラピストを取得する。
 */
export async function getTherapistBySlug(slug: string): Promise<TherapistListItem | null> {
  const session = await getDevSession();
  if (!session) return null;

  const sql = getClient();

  return withUser(sql, session, async (tx) => {
    const rows = await tx<{
      id: string;
      slug: string;
      status: string;
      display_order: number;
      app_user_id: string | null;
      retired_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }[]>`
      select id, slug, status, display_order, app_user_id, retired_at, created_at, updated_at
      from therapists
      where slug = ${slug}
      limit 1
    `;

    const r = rows[0];
    if (!r) return null;

    return {
      id: r.id,
      slug: r.slug,
      status: r.status as "active" | "inactive" | "retired",
      displayOrder: r.display_order,
      appUserId: r.app_user_id,
      retiredAt: r.retired_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}
