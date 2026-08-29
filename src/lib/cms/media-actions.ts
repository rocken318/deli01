"use server";

import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import type { ActionResult } from "@/lib/cms/actions";

const upsertMediaSchema = z.object({
  id: z.string().uuid().optional(),
  storagePath: z.string().default(""),
  url: z.string().default(""),
  mime: z.string().default("image/webp"),
  width: z.number().int().positive().optional().nullable(),
  height: z.number().int().positive().optional().nullable(),
  alt: z.string().min(1, "alt テキストは必須です（spec 3-7）"),
  tags: z.array(z.string()).default([]),
  consentFlag: z.boolean().default(false),
  consentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  faceVisibility: z.enum(["face", "eyes", "none"]).default("none"),
  isPlaceholder: z.boolean().default(false),
});

export type UpsertMediaInput = z.infer<typeof upsertMediaSchema>;

export async function upsertMediaMeta(input: UpsertMediaInput): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  const actor = toActor(session);
  if (!can(actor, "manage_cms")) return { ok: false, error: "権限がありません" };

  const parsed = upsertMediaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };

  const data = parsed.data;
  const sql = getClient();

  try {
    const result = await withUser(sql, session, async (tx) => {
      if (data.id) {
        await tx`
          update media set
            storage_path = ${data.storagePath}, url = ${data.url}, mime = ${data.mime},
            width = ${data.width ?? null}, height = ${data.height ?? null},
            alt = ${data.alt}, tags = ${data.tags}::text[],
            consent_flag = ${data.consentFlag}, consent_date = ${data.consentDate ?? null},
            face_visibility = ${data.faceVisibility}::face_visibility,
            is_placeholder = ${data.isPlaceholder}
          where id = ${data.id}::uuid
        `;
        await tx`
          insert into audit_logs (actor_user_id, action, entity, entity_id, after)
          values (${session.userId}::uuid, 'update', 'media', ${data.id}::uuid, ${JSON.stringify({ alt: data.alt, tags: data.tags })}::jsonb)
        `;
        return { id: data.id };
      } else {
        const rows = await tx<{ id: string }[]>`
          insert into media (storage_path, url, mime, width, height, alt, tags, consent_flag, consent_date, face_visibility, is_placeholder)
          values (${data.storagePath}, ${data.url}, ${data.mime}, ${data.width ?? null}, ${data.height ?? null},
            ${data.alt}, ${data.tags}::text[], ${data.consentFlag}, ${data.consentDate ?? null},
            ${data.faceVisibility}::face_visibility, ${data.isPlaceholder})
          returning id
        `;
        const row = rows[0];
        if (!row) throw new Error("insert failed");
        await tx`
          insert into audit_logs (actor_user_id, action, entity, entity_id, after)
          values (${session.userId}::uuid, 'create', 'media', ${row.id}::uuid, ${JSON.stringify({ alt: data.alt, tags: data.tags })}::jsonb)
        `;
        return { id: row.id };
      }
    });
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

export async function listMedia(opts: { tag?: string; isPlaceholder?: boolean } = {}): Promise<{
  id: string; url: string; alt: string; tags: string[]; isPlaceholder: boolean; consentFlag: boolean; createdAt: string;
}[]> {
  const sql = getClient();
  type Row = { id: string; url: string; alt: string; tags: string[]; is_placeholder: boolean; consent_flag: boolean; created_at: string };
  const toItem = (r: Row) => ({ id: r.id, url: r.url, alt: r.alt, tags: r.tags, isPlaceholder: r.is_placeholder, consentFlag: r.consent_flag, createdAt: r.created_at });

  if (opts.tag !== undefined) {
    const rows = await sql<Row[]>`select id, url, alt, tags, is_placeholder, consent_flag, created_at from media where ${opts.tag}::text = any(tags) order by created_at desc`;
    return rows.map(toItem);
  }
  if (opts.isPlaceholder !== undefined) {
    const rows = await sql<Row[]>`select id, url, alt, tags, is_placeholder, consent_flag, created_at from media where is_placeholder = ${opts.isPlaceholder} order by created_at desc`;
    return rows.map(toItem);
  }
  const rows = await sql<Row[]>`select id, url, alt, tags, is_placeholder, consent_flag, created_at from media order by created_at desc`;
  return rows.map(toItem);
}
