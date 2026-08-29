"use server";

import { z } from "zod";
import type postgres from "postgres";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import type { ActionResult } from "@/lib/cms/actions";

const saveSettingSchema = z.object({
  key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
  value: z.unknown(),
});

export async function saveSiteSetting(key: string, value: unknown): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  const actor = toActor(session);
  if (!can(actor, "manage_cms")) return { ok: false, error: "権限がありません" };

  const parsed = saveSettingSchema.safeParse({ key, value });
  if (!parsed.success) return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };

  const sql = getClient();
  try {
    await withUser(sql, session, async (tx) => {
      const existing = await tx<{ value: unknown }[]>`select value from site_settings where key = ${parsed.data.key}`;
      const before = existing[0]?.value ?? null;
      await tx`
        insert into site_settings (key, value)
        values (${parsed.data.key}, ${tx.json(parsed.data.value as postgres.JSONValue)})
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `;
      await tx`
        insert into audit_logs (actor_user_id, action, entity, before, after)
        values (${session.userId}::uuid, 'update', 'site_setting',
          ${tx.json({ key: parsed.data.key, value: before } as postgres.JSONValue)},
          ${tx.json({ key: parsed.data.key, value: parsed.data.value } as postgres.JSONValue)})
      `;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

export async function getAllSiteSettings(): Promise<Record<string, unknown>> {
  const sql = getClient();
  const rows = await sql<{ key: string; value: unknown }[]>`select key, value from site_settings`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
