"use server";

/**
 * AI アシスタントの Server Actions（フェーズ21 / spec 19章）。
 *
 * 安全ゲート（完了条件）:
 * - runAiAssist: AI を呼び ai_actions に status='proposed' で記録。
 *   この時点では draft にも published にも一切書かない（受入 L1124）。
 * - approveAiAction: 承認時に draft のみ更新。published は絶対に触らない。
 *   structure_change は差分プレビュー後の承認で draft に適用（受入 L1125）。
 * - rejectAiAction: status='rejected'。何も適用しない。
 * - 全操作が ai_actions に記録される（受入 L1126）。
 */

import { z } from "zod";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { withUser } from "@/lib/auth/with-user";
import { getClient } from "@/lib/db-client";
import { getDevSession } from "@/lib/cms/dev-session";
import {
  generateDraft,
  suggestBannedWordRewrite,
  suggestTerminology,
} from "./assist";
import type {
  GenerateKind,
  GenerateDraftInput,
  BannedWordRewriteInput,
  TerminologySuggestInput,
} from "./assist";

/** Server Action の共通レスポンス型 */
export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export type AiActionType =
  | "generate"
  | "rewrite"
  | "banned_word_suggest"
  | "terminology_suggest"
  | "structure_change";

export type AiActionStatus = "proposed" | "approved" | "rejected" | "failed";

export interface AiActionRow {
  id: string; // bigint as string
  action_type: AiActionType;
  entity: string | null;
  request: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: AiActionStatus;
  created_by: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
}

/** runAiAssist の入力 */
export interface RunAiAssistInput {
  actionType: AiActionType;
  entity?: string;
  request: Record<string, unknown>;
}

/** runAiAssist の出力（提案） */
export interface AiAssistOutput {
  aiActionId: string;
  output: Record<string, unknown>;
  /** AI 出力に禁止語が含まれていた場合の警告 */
  detectedBannedWords?: string[];
}

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

const runAiAssistSchema = z.object({
  actionType: z.enum([
    "generate",
    "rewrite",
    "banned_word_suggest",
    "terminology_suggest",
    "structure_change",
  ]),
  entity: z.string().max(255).optional(),
  request: z.record(z.string(), z.unknown()),
});

const approveRejectSchema = z.object({
  id: z.string().regex(/^\d+$/, "id は整数文字列"),
});

// ---------------------------------------------------------------------------
// 1. runAiAssist
// ---------------------------------------------------------------------------

/**
 * AI を呼び出し、結果を ai_actions に proposed で記録して返す。
 * この時点では entity_records.draft / pages.draft_blocks には一切書かない。
 */
export async function runAiAssist(
  input: RunAiAssistInput,
): Promise<ActionResult<AiAssistOutput>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  // staff（owner/admin/reception）のみ実行可能
  if (
    actor.role !== "owner" &&
    actor.role !== "admin" &&
    actor.role !== "reception"
  ) {
    return { ok: false, error: "この操作にはスタッフのロールが必要です" };
  }

  const parsed = runAiAssistSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const data = parsed.data;
  const sql = getClient();

  // AI 呼び出し（withUser の外で行う。DB 接続前にキー未設定を確認するため）
  let aiOutput: Record<string, unknown>;
  let aiStatus: AiActionStatus;
  let detectedBannedWords: string[] | undefined;

  try {
    const result = await callAi(data.actionType, data.request);
    if (!result.ok) {
      // AI 未設定 or エラー → failed で記録
      aiOutput = { error: result.error };
      aiStatus = "failed";
    } else {
      aiOutput = result.output;
      aiStatus = "proposed";
      detectedBannedWords = result.detectedBannedWords;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "AI呼び出しエラー";
    aiOutput = { error: msg };
    aiStatus = "failed";
  }

  try {
    const result = await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into ai_actions
          (action_type, entity, request, output, status, created_by)
        values (
          ${data.actionType}::ai_action_type,
          ${data.entity ?? null},
          ${tx.json(data.request as Parameters<typeof tx.json>[0])},
          ${tx.json(aiOutput as Parameters<typeof tx.json>[0])},
          ${aiStatus}::ai_action_status,
          ${session.userId}::uuid
        )
        returning id::text
      `;
      const row = rows[0];
      if (!row) throw new Error("ai_actions insert failed");
      return { id: row.id };
    });

    if (aiStatus === "failed") {
      return {
        ok: false,
        error: (aiOutput as { error?: string }).error ?? "AIエラー",
        data: { aiActionId: result.id, output: aiOutput },
      };
    }

    return {
      ok: true,
      data: {
        aiActionId: result.id,
        output: aiOutput,
        ...(detectedBannedWords && detectedBannedWords.length > 0
          ? { detectedBannedWords }
          : {}),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// 2. approveAiAction
// ---------------------------------------------------------------------------

/**
 * AI 提案を承認する（owner/admin のみ）。
 * - 承認時は entity_records.draft または pages.draft_blocks のみ更新する。
 * - published は絶対に触らない（受入 L1124）。
 * - structure_change は差分プレビュー後の承認で draft に適用（受入 L1125）。
 */
export async function approveAiAction(id: string): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "承認には owner または admin のロールが必要です" };
  }

  const parsed = approveRejectSchema.safeParse({ id });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    return await withUser(sql, session, async (tx): Promise<ActionResult> => {
      // ai_actions を取得
      const rows = await tx<AiActionRow[]>`
        select id::text, action_type, entity, request, output, status
        from ai_actions
        where id = ${parsed.data.id}::bigint
      `;
      const action = rows[0];
      if (!action) return { ok: false, error: "AI操作が見つかりません" };
      if (action.status !== "proposed") {
        return { ok: false, error: `既に ${action.status} の操作は変更できません` };
      }

      // draft への反映（action_type と entity によって対象テーブルが異なる）
      await applyToDraft(tx, action);

      // status を approved に更新
      await tx`
        update ai_actions
        set status = 'approved'::ai_action_status,
            reviewed_by = ${session.userId}::uuid
        where id = ${parsed.data.id}::bigint
      `;

      // 監査ログ
      await tx`
        insert into audit_logs (actor_user_id, action, entity, after)
        values (
          ${session.userId}::uuid,
          'ai_approve',
          'ai_action',
          ${tx.json({ id: parsed.data.id, action_type: action.action_type, entity: action.entity })}
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
// 3. rejectAiAction
// ---------------------------------------------------------------------------

/**
 * AI 提案を却下する（owner/admin のみ）。何も適用しない。
 */
export async function rejectAiAction(
  id: string,
  reason?: string,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (!can(actor, "manage_cms")) {
    return { ok: false, error: "却下には owner または admin のロールが必要です" };
  }

  const parsed = approveRejectSchema.safeParse({ id });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join(", ") };
  }

  const sql = getClient();

  try {
    return await withUser(sql, session, async (tx): Promise<ActionResult> => {
      const rows = await tx<{ status: string }[]>`
        select status from ai_actions where id = ${parsed.data.id}::bigint
      `;
      const action = rows[0];
      if (!action) return { ok: false, error: "AI操作が見つかりません" };
      if (action.status !== "proposed") {
        return { ok: false, error: `既に ${action.status} の操作は変更できません` };
      }

      if (reason) {
        await tx`
          update ai_actions
          set status = 'rejected'::ai_action_status,
              reviewed_by = ${session.userId}::uuid,
              output = coalesce(output, '{}'::jsonb) || ${tx.json({ rejection_reason: reason } as Record<string, string>)}
          where id = ${parsed.data.id}::bigint
        `;
      } else {
        await tx`
          update ai_actions
          set status = 'rejected'::ai_action_status,
              reviewed_by = ${session.userId}::uuid
          where id = ${parsed.data.id}::bigint
        `;
      }

      await tx`
        insert into audit_logs (actor_user_id, action, entity, after)
        values (
          ${session.userId}::uuid,
          'ai_reject',
          'ai_action',
          ${tx.json({ id: parsed.data.id, reason: reason ?? null })}
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
// 4. listAiActions: 履歴一覧
// ---------------------------------------------------------------------------

export interface AiActionListItem {
  id: string;
  action_type: AiActionType;
  entity: string | null;
  request: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: AiActionStatus;
  created_by_name: string | null;
  reviewed_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export async function listAiActions(limit = 50): Promise<ActionResult<AiActionListItem[]>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: "認証が必要です" };

  const actor = toActor(session);
  if (
    actor.role !== "owner" &&
    actor.role !== "admin" &&
    actor.role !== "reception"
  ) {
    return { ok: false, error: "閲覧にはスタッフのロールが必要です" };
  }

  const sql = getClient();

  try {
    const rows = await withUser(sql, session, async (tx) => {
      return tx<AiActionListItem[]>`
        select
          a.id::text,
          a.action_type,
          a.entity,
          a.request,
          a.output,
          a.status,
          u1.display_name as created_by_name,
          u2.display_name as reviewed_by_name,
          a.created_at::text,
          a.updated_at::text
        from ai_actions a
        left join app_users u1 on u1.id = a.created_by
        left join app_users u2 on u2.id = a.reviewed_by
        order by a.created_at desc
        limit ${limit}
      `;
    });

    return { ok: true, data: rows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// 内部ヘルパ: AI 呼び出しルーティング
// ---------------------------------------------------------------------------

interface AiCallResult {
  ok: true;
  output: Record<string, unknown>;
  detectedBannedWords?: string[];
}
interface AiCallError {
  ok: false;
  error: string;
}

async function callAi(
  actionType: AiActionType,
  request: Record<string, unknown>,
): Promise<AiCallResult | AiCallError> {
  switch (actionType) {
    case "generate":
    case "rewrite": {
      const input: GenerateDraftInput = {
        kind: (request["kind"] as GenerateKind) ?? "profile",
        context: request["context"] as string | undefined,
        instruction: request["instruction"] as string | undefined,
        bannedWords: request["bannedWords"] as string[] | undefined,
      };
      const result = await generateDraft(input);
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        output: { draft: result.draft },
        detectedBannedWords: result.detectedBannedWords,
      };
    }
    case "banned_word_suggest": {
      const input: BannedWordRewriteInput = {
        text: (request["text"] as string) ?? "",
        bannedWords: (request["bannedWords"] as string[]) ?? [],
      };
      const result = await suggestBannedWordRewrite(input);
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        output: { detected: result.detected, suggestion: result.suggestion },
      };
    }
    case "terminology_suggest": {
      const input: TerminologySuggestInput = {
        text: (request["text"] as string) ?? "",
        terminology: (request["terminology"] as Array<{ key: string; value: string }>) ?? [],
      };
      const result = await suggestTerminology(input);
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        output: { suggestion: result.suggestion, changes: result.changes },
      };
    }
    case "structure_change": {
      // 構造変更は「提案のみ」。実際の適用は applyToDraft 承認時に行う
      // ここでは request の proposal をそのまま AI 出力として返す
      // （フロント側から構造変更案を request.proposal に入れて渡す）
      const proposal = request["proposal"];
      if (!proposal) {
        return { ok: false, error: "structure_change には request.proposal が必要です" };
      }
      return { ok: true, output: { proposal } };
    }
    default:
      return { ok: false, error: `不明な actionType: ${String(actionType)}` };
  }
}

// ---------------------------------------------------------------------------
// 内部ヘルパ: 承認時の draft 反映（published は絶対に触らない）
// ---------------------------------------------------------------------------

import type { TransactionSql } from "postgres";

async function applyToDraft(
  tx: TransactionSql,
  action: AiActionRow,
): Promise<void> {
  if (!action.output) return; // failed や空は何もしない

  const output = action.output;

  switch (action.action_type) {
    case "generate":
    case "rewrite":
    case "banned_word_suggest":
    case "terminology_suggest": {
      // entity が "page:{slug}" 形式なら pages.draft_fields を更新
      // entity が "record:{entity}:{slug}" 形式なら entity_records.draft を更新
      // entity が "terminology" なら terminology テーブルの value を更新（key は request から）
      // entity が null / 不明なら何もしない（提案だけ記録）
      if (!action.entity) return;

      const suggestion = (output as { draft?: string; suggestion?: string }).draft
        ?? (output as { draft?: string; suggestion?: string }).suggestion;
      if (suggestion === undefined) return;

      if (action.entity.startsWith("record:")) {
        // record:{entity}:{slug}
        const parts = action.entity.split(":");
        if (parts.length < 3) return;
        const entityName = parts[1] as string;
        const recSlug = parts[2] as string;
        const fieldKey = (action.request as { fieldKey?: string }).fieldKey;
        if (!fieldKey) return;

        // entity_records.draft のみ更新（published は触らない）
        const patchRec = tx.json({ [fieldKey]: suggestion } as Record<string, string>);
        await tx`
          update entity_records
          set draft = draft || ${patchRec},
              updated_at = now()
          where entity = ${entityName} and slug = ${recSlug}
        `;
      } else if (action.entity.startsWith("page:")) {
        const slug = action.entity.slice(5);
        const fieldKey = (action.request as { fieldKey?: string }).fieldKey;
        if (!fieldKey) return;

        // pages.draft_fields のみ更新（published_fields は触らない）
        const patchPage = tx.json({ [fieldKey]: suggestion });
        await tx`
          update pages
          set draft_fields = draft_fields || ${patchPage},
              updated_at = now()
          where slug = ${slug}
        `;
      }
      break;
    }
    case "structure_change": {
      // 構造変更提案の承認
      // request.target に適用先（"entity_records" / "pages"）、
      // output.proposal に変更内容が入っている
      // → draft_blocks を更新（published_blocks は触らない / 受入 L1124・L1125）
      const proposal = output as {
        proposal?: { slug?: string; draftBlocks?: unknown };
      };
      if (!proposal.proposal) return;

      const { slug, draftBlocks } = proposal.proposal ?? {};
      if (!slug || draftBlocks === undefined) return;

      // pages.draft_blocks のみ更新
      await tx`
        update pages
        set draft_blocks = ${tx.json(draftBlocks as Parameters<typeof tx.json>[0])},
            updated_at = now()
        where slug = ${String(slug)}
      `;
      break;
    }
    default:
      break;
  }
}
