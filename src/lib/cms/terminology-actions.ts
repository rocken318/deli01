"use server";

import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import type { ActionResult } from "@/lib/cms/actions";

const saveTermSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  locale: z.string().default("ja"),
});

export async function saveTerminology(key: string, value: string, locale = "ja"): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };
  const actor = toActor(session);
  if (!can(actor, "manage_cms")) return { ok: false, error: "権限がありません" };

  const parsed = saveTermSchema.safeParse({ key, value, locale });
  if (!parsed.success) return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };

  const sql = getClient();
  try {
    await withUser(sql, session, async (tx) => {
      await tx`
        insert into terminology (key, value, locale)
        values (${parsed.data.key}, ${parsed.data.value}, ${parsed.data.locale})
        on conflict (key, locale) do update set value = excluded.value, updated_at = now()
      `;
      await tx`
        insert into audit_logs (actor_user_id, action, entity, after)
        values (${session.userId}::uuid, 'update', 'terminology', ${JSON.stringify(parsed.data)}::jsonb)
      `;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "不明なエラー" };
  }
}

export async function getAllTerminology(locale = "ja"): Promise<Record<string, string>> {
  const sql = getClient();
  const rows = await sql<{ key: string; value: string }[]>`select key, value from terminology where locale = ${locale}`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
