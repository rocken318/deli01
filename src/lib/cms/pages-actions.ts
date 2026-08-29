"use server";

import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import { blocksArraySchema, type Block } from "@/domain/cms/blocks";
import { checkBannedWords } from "@/domain/cms/banned-words";
import type { ActionResult } from "@/lib/cms/actions";

const pageFieldsSchema = z.object({
  heading: z.string().default(""),
  lead: z.string().default(""),
  heroImageId: z.string().nullable().default(null),
  seoTitle: z.string().default(""),
  seoDescription: z.string().default(""),
});

export type PageFields = z.infer<typeof pageFieldsSchema>;

export async function savePageFields(slug: string, fields: PageFields, locale = "ja"): Promise<ActionResult<{ id: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  const actor = toActor(session);
  if (!can(actor, "manage_cms")) return { ok: false, error: "権限がありません" };

  const parsedSlug = z.string().min(1).regex(/^[a-z0-9-]+$/).safeParse(slug);
  if (!parsedSlug.success) return { ok: false, error: "slug が不正です" };

  const parsedFields = pageFieldsSchema.safeParse(fields);
  if (!parsedFields.success) return { ok: false, error: parsedFields.error.errors.map((e) => e.message).join(", ") };

  const sql = getClient();
  try {
    const result = await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into pages (slug, locale, draft_fields)
        values (${slug}, ${locale}, ${JSON.stringify(parsedFields.data)}::jsonb)
        on conflict (slug, locale) do update set draft_fields = excluded.draft_fields, updated_at = now()
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error("upsert failed");
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (${session.userId}::uuid, 'update', 'page', ${row.id}::uuid, ${JSON.stringify({ slug, locale })}::jsonb)
      `;
      return { id: row.id };
    });
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

export async function savePageBlocks(slug: string, blocks: Block[], locale = "ja"): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  const actor = toActor(session);
  if (!can(actor, "manage_cms")) return { ok: false, error: "権限がありません" };

  const parsedBlocks = blocksArraySchema.safeParse(blocks);
  if (!parsedBlocks.success) return { ok: false, error: parsedBlocks.error.errors.map((e) => e.message).join(", ") };

  const sql = getClient();
  try {
    await withUser(sql, session, async (tx) => {
      await tx`
        insert into pages (slug, locale, draft_blocks)
        values (${slug}, ${locale}, ${JSON.stringify(parsedBlocks.data)}::jsonb)
        on conflict (slug, locale) do update set draft_blocks = excluded.draft_blocks, updated_at = now()
      `;
      await tx`
        insert into audit_logs (actor_user_id, action, entity, after)
        values (${session.userId}::uuid, 'update', 'page_blocks', ${JSON.stringify({ slug, locale, count: parsedBlocks.data.length })}::jsonb)
      `;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

export interface PublishPageResult { warnings: string[] }

export async function publishPage(slug: string, locale = "ja"): Promise<ActionResult<PublishPageResult>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  const actor = toActor(session);
  if (!can(actor, "manage_cms")) return { ok: false, error: "権限がありません" };

  const sql = getClient();
  try {
    return await withUser(sql, session, async (tx): Promise<ActionResult<PublishPageResult>> => {
      const rows = await tx<{ id: string; draft_fields: Record<string, unknown>; draft_blocks: unknown[] }[]>`
        select id, draft_fields, draft_blocks from pages where slug = ${slug} and locale = ${locale}
      `;
      const page = rows[0];
      if (!page) return { ok: false, error: "ページが見つかりません" };

      const wordRows = await tx<{ word: string }[]>`select word from banned_words`;
      const wordList = wordRows.map((r) => r.word);
      const allText = JSON.stringify(page.draft_fields) + " " + JSON.stringify(page.draft_blocks);
      const warnings = checkBannedWords(allText, wordList).map((w) => `禁止語「${w}」が含まれています`);

      await tx`
        update pages set published_fields = draft_fields, published_blocks = draft_blocks, published_at = now()
        where id = ${page.id}::uuid
      `;
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id)
        values (${session.userId}::uuid, 'publish', 'page', ${page.id}::uuid)
      `;
      return { ok: true, data: { warnings } };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

export async function listPages(locale = "ja"): Promise<{ id: string; slug: string; publishedAt: string | null; updatedAt: string }[]> {
  const sql = getClient();
  const rows = await sql<{ id: string; slug: string; published_at: string | null; updated_at: string }[]>`
    select id, slug, published_at, updated_at from pages where locale = ${locale} order by slug
  `;
  return rows.map((r) => ({ id: r.id, slug: r.slug, publishedAt: r.published_at, updatedAt: r.updated_at }));
}

export async function getPage(slug: string, locale = "ja"): Promise<{
  id: string; slug: string;
  draftFields: Record<string, unknown>;
  publishedFields: Record<string, unknown> | null;
  draftBlocks: Block[];
  publishedBlocks: Block[] | null;
  publishedAt: string | null;
} | null> {
  const sql = getClient();
  const rows = await sql<{
    id: string; slug: string;
    draft_fields: Record<string, unknown>;
    published_fields: Record<string, unknown> | null;
    draft_blocks: unknown;
    published_blocks: unknown | null;
    published_at: string | null;
  }[]>`
    select id, slug, draft_fields, published_fields, draft_blocks, published_blocks, published_at
    from pages where slug = ${slug} and locale = ${locale}
  `;
  const row = rows[0];
  if (!row) return null;

  const draftBlocks = blocksArraySchema.parse(row.draft_blocks ?? []);
  const publishedBlocks = row.published_blocks ? blocksArraySchema.parse(row.published_blocks) : null;

  return {
    id: row.id, slug: row.slug,
    draftFields: row.draft_fields,
    publishedFields: row.published_fields,
    draftBlocks, publishedBlocks,
    publishedAt: row.published_at,
  };
}
