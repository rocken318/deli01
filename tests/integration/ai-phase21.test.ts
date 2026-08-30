import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

/**
 * フェーズ21 統合テスト（実 Postgres / spec 19章・受入 L1124-L1126）。
 *
 * ★ @anthropic-ai/sdk を vi.mock してモック AI を使用（CI にキー無し）。
 * 実 API は絶対に叩かない。
 *
 * 検証する安全ゲート:
 * (a) runAiAssist が ai_actions に proposed で記録・published を書かない（受入 L1124）
 * (b) approveAiAction が draft のみ更新し published 不変（受入 L1124）
 * (c) structure_change が承認前に draft に適用されない（受入 L1125）
 * (d) 全操作が ai_actions に記録（受入 L1126）
 * (e) AI 出力にも禁止語チェックがかかる（spec L1256）
 * (f) キー未設定で failed（ビルド/起動を壊さない）
 */

// ---------------------------------------------------------------------------
// モック: @anthropic-ai/sdk（CI にキー無し・実 API を叩かない）
// ---------------------------------------------------------------------------
const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
  // エラークラス（safeError でのキャッチに使う）
  class RateLimitError extends Error { status = 429; }
  class AuthenticationError extends Error { status = 401; }
  class APIConnectionError extends Error {}
  class APIError extends Error { status?: number; }
  return {
    default: Object.assign(Anthropic, { RateLimitError, AuthenticationError, APIConnectionError, APIError }),
    RateLimitError,
    AuthenticationError,
    APIConnectionError,
    APIError,
  };
});

// ---------------------------------------------------------------------------
// モック: getDevSession（owner / reception を切り替えられるよう）
// ---------------------------------------------------------------------------
const mockAuth = vi.hoisted(() => ({
  session: null as { userId: string; role: string } | null,
}));
vi.mock("@/lib/cms/dev-session", () => ({
  getDevSession: async () => mockAuth.session,
}));

// ---------------------------------------------------------------------------
// モック: src/lib/ai/client.ts の _resetClientCache（require mock のため）
// ---------------------------------------------------------------------------
// client.ts は require('@anthropic-ai/sdk') を動的に呼ぶ。
// vi.mock('@anthropic-ai/sdk') が先に差し込まれるので SDK モックが効く。

import { _resetClientCache } from "@/lib/ai/client";
import { runAiAssist, approveAiAction, rejectAiAction, listAiActions } from "@/lib/ai/actions";
import { generateDraft, suggestBannedWordRewrite } from "@/lib/ai/assist";

// ---------------------------------------------------------------------------
// DB 接続
// ---------------------------------------------------------------------------
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

// テスト用のダミーユーザー ID（seed の owner）
const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const ownerSession: Session = { userId: OWNER_ID, role: "owner" };

// ---------------------------------------------------------------------------
// セットアップ
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // DB が生きているか確認
  await sql`select 1`;
});

afterAll(async () => {
  await sql.end();
});

afterEach(() => {
  mockCreate.mockReset();
  _resetClientCache();
  mockAuth.session = null;
});

// ---------------------------------------------------------------------------
// AI レスポンスのモックヘルパ
// ---------------------------------------------------------------------------
function mockAiResponse(text: string) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: "text", text }],
  });
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("フェーズ21: AI アシスタント 安全ゲート", () => {
  // -----------------------------------------------------------------------
  // (a)(d) runAiAssist が ai_actions に proposed で記録・published を書かない
  // -----------------------------------------------------------------------
  describe("(a)(d) runAiAssist: proposed 記録・published 不変", () => {
    it("正常系: AI 成功 → proposed で記録・entity_records.published は変わらない", async () => {
      // モック AI レスポンスをセット
      mockAiResponse("これはモックの下書きテキストです");

      // owner セッション
      mockAuth.session = ownerSession;

      // ANTHROPIC_API_KEY を設定（モック SDK が動くように）
      process.env["ANTHROPIC_API_KEY"] = "test-key-dummy";

      // テスト対象の entity_record を確認（seed データを使用）
      const [rec] = await sql<{ id: string; published: unknown }[]>`
        select id, published from entity_records
        where entity = 'therapist' and slug = 'aoi'
        limit 1
      `;

      const publishedBefore = rec?.published;

      const result = await runAiAssist({
        actionType: "generate",
        entity: "record:therapist:aoi",
        request: { kind: "profile", fieldKey: "profile_text" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok || !result.data) throw new Error("result.data が空");

      const { aiActionId, output } = result.data;
      expect(aiActionId).toBeTruthy();
      expect((output as { draft?: string }).draft).toBe("これはモックの下書きテキストです");

      // ai_actions に proposed で記録されていること（受入 L1126）
      const [action] = await sql<{ status: string; action_type: string }[]>`
        select status, action_type from ai_actions where id = ${aiActionId}::bigint
      `;
      expect(action).toBeTruthy();
      expect(action!.status).toBe("proposed");
      expect(action!.action_type).toBe("generate");

      // entity_records.published は変わっていない（受入 L1124）
      if (rec) {
        const [after] = await sql<{ published: unknown }[]>`
          select published from entity_records where id = ${rec.id}::uuid
        `;
        expect(JSON.stringify(after?.published)).toBe(JSON.stringify(publishedBefore));
      }

      delete process.env["ANTHROPIC_API_KEY"];
    });

    it("entity_records.draft は runAiAssist では変わらない（承認前は何も書かない）", async () => {
      mockAiResponse("モック下書き");
      mockAuth.session = ownerSession;
      process.env["ANTHROPIC_API_KEY"] = "test-key-dummy";

      const [rec] = await sql<{ draft: unknown }[]>`
        select draft from entity_records where entity = 'therapist' and slug = 'aoi'
      `;
      const draftBefore = JSON.stringify(rec?.draft);

      await runAiAssist({
        actionType: "generate",
        entity: "record:therapist:aoi",
        request: { kind: "profile", fieldKey: "profile_text" },
      });

      const [after] = await sql<{ draft: unknown }[]>`
        select draft from entity_records where entity = 'therapist' and slug = 'aoi'
      `;
      // draft も承認前は変わらない
      expect(JSON.stringify(after?.draft)).toBe(draftBefore);

      delete process.env["ANTHROPIC_API_KEY"];
    });
  });

  // -----------------------------------------------------------------------
  // (b) approveAiAction が draft のみ更新し published 不変
  // -----------------------------------------------------------------------
  describe("(b) approveAiAction: draft のみ更新・published 不変", () => {
    it("承認 → entity_records.draft に反映・published は変わらない", async () => {
      mockAiResponse("承認テスト用モック下書き");
      mockAuth.session = ownerSession;
      process.env["ANTHROPIC_API_KEY"] = "test-key-dummy";

      // まず proposed を作る
      const runResult = await runAiAssist({
        actionType: "generate",
        entity: "record:therapist:aoi",
        request: { kind: "profile", fieldKey: "profile_text" },
      });
      expect(runResult.ok).toBe(true);
      if (!runResult.ok || !runResult.data) throw new Error();
      const { aiActionId } = runResult.data;

      // published の状態を記録
      const [before] = await sql<{ draft: Record<string, unknown>; published: unknown }[]>`
        select draft, published from entity_records
        where entity = 'therapist' and slug = 'aoi'
      `;
      const publishedBefore = JSON.stringify(before?.published);

      // 承認
      const approveResult = await approveAiAction(aiActionId);
      expect(approveResult.ok).toBe(true);

      // draft の profile_text が更新されている
      const [after] = await sql<{ draft: Record<string, unknown>; published: unknown }[]>`
        select draft, published from entity_records
        where entity = 'therapist' and slug = 'aoi'
      `;
      expect((after?.draft as Record<string, unknown>)?.["profile_text"]).toBe(
        "承認テスト用モック下書き"
      );

      // published は絶対に変わっていない（受入 L1124）
      expect(JSON.stringify(after?.published)).toBe(publishedBefore);

      // ai_actions が approved になっている
      const [action] = await sql<{ status: string; reviewed_by: string }[]>`
        select status, reviewed_by::text from ai_actions where id = ${aiActionId}::bigint
      `;
      expect(action!.status).toBe("approved");
      expect(action!.reviewed_by).toBe(OWNER_ID);

      delete process.env["ANTHROPIC_API_KEY"];
    });
  });

  // -----------------------------------------------------------------------
  // (c) structure_change が承認前に draft に適用されない
  // -----------------------------------------------------------------------
  describe("(c) structure_change: 承認前に draft に適用されない", () => {
    it("runAiAssist(structure_change) は proposed のみ → draft_blocks は変わらない", async () => {
      mockAuth.session = ownerSession;
      process.env["ANTHROPIC_API_KEY"] = "test-key-dummy";

      // pages の draft_blocks を記録
      const [page] = await sql<{ draft_blocks: unknown }[]>`
        select draft_blocks from pages where slug = 'home' limit 1
      `;
      const draftBlocksBefore = JSON.stringify(page?.draft_blocks);

      // structure_change では callAi が proposal をそのまま出力する
      const result = await runAiAssist({
        actionType: "structure_change",
        entity: "page:home",
        request: {
          proposal: {
            slug: "home",
            draftBlocks: [{ type: "text", content: "テスト変更" }],
          },
        },
      });

      expect(result.ok).toBe(true);

      // draft_blocks は変わっていない（承認前 / 受入 L1125）
      const [afterPage] = await sql<{ draft_blocks: unknown }[]>`
        select draft_blocks from pages where slug = 'home' limit 1
      `;
      expect(JSON.stringify(afterPage?.draft_blocks)).toBe(draftBlocksBefore);

      // ai_actions には proposed で記録されている（受入 L1126）
      if (result.ok && result.data) {
        const [action] = await sql<{ status: string; action_type: string }[]>`
          select status, action_type from ai_actions where id = ${result.data.aiActionId}::bigint
        `;
        expect(action!.status).toBe("proposed");
        expect(action!.action_type).toBe("structure_change");
      }

      delete process.env["ANTHROPIC_API_KEY"];
    });
  });

  // -----------------------------------------------------------------------
  // (e) AI 出力にも禁止語チェックがかかる
  // -----------------------------------------------------------------------
  describe("(e) AI 出力の禁止語チェック（二重防御）", () => {
    it("generateDraft の出力に禁止語が含まれると detectedBannedWords を返す", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-dummy";

      // モック AI が禁止語を含む出力を返す
      mockAiResponse("マッサージが得意なセラピストです");

      const result = await generateDraft({
        kind: "profile",
        bannedWords: ["マッサージ", "治療"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();

      expect(result.detectedBannedWords).toContain("マッサージ");

      delete process.env["ANTHROPIC_API_KEY"];
    });

    it("禁止語を含まない出力では detectedBannedWords は空", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-dummy";
      mockAiResponse("リラクゼーションが得意なセラピストです");

      const result = await generateDraft({
        kind: "profile",
        bannedWords: ["マッサージ"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.detectedBannedWords ?? []).toHaveLength(0);

      delete process.env["ANTHROPIC_API_KEY"];
    });
  });

  // -----------------------------------------------------------------------
  // (f) キー未設定で failed（ビルド/起動を壊さない）
  // -----------------------------------------------------------------------
  describe("(f) ANTHROPIC_API_KEY 未設定で failed", () => {
    it("キー未設定でも runAiAssist は ok:false を返し、ai_actions に failed で記録する", async () => {
      mockAuth.session = ownerSession;
      // キーを確実に未設定にする
      delete process.env["ANTHROPIC_API_KEY"];

      const result = await runAiAssist({
        actionType: "generate",
        request: { kind: "profile" },
      });

      // ok: false を返す（アプリは落ちない）
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/AI|未設定|ANTHROPIC_API_KEY/i);

      // data.aiActionId があれば ai_actions に failed で記録されている
      if (result.data?.aiActionId) {
        const [action] = await sql<{ status: string }[]>`
          select status from ai_actions where id = ${result.data.aiActionId}::bigint
        `;
        expect(action!.status).toBe("failed");
      }
    });

    it("generateDraft はキー未設定で ok:false（throw しない）", async () => {
      delete process.env["ANTHROPIC_API_KEY"];

      const result = await generateDraft({ kind: "profile" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/AI|未設定|ANTHROPIC_API_KEY/i);
      }
    });
  });

  // -----------------------------------------------------------------------
  // (d) 全操作が ai_actions に記録（rejectAiAction も記録）
  // -----------------------------------------------------------------------
  describe("(d) 全操作が ai_actions に記録される", () => {
    it("rejectAiAction が status=rejected・reviewed_by を記録", async () => {
      mockAiResponse("却下テスト");
      mockAuth.session = ownerSession;
      process.env["ANTHROPIC_API_KEY"] = "test-key-dummy";

      const runResult = await runAiAssist({
        actionType: "generate",
        request: { kind: "catch" },
      });
      expect(runResult.ok).toBe(true);
      if (!runResult.ok || !runResult.data) throw new Error();

      const { aiActionId } = runResult.data;

      const rejectResult = await rejectAiAction(aiActionId, "テスト理由");
      expect(rejectResult.ok).toBe(true);

      const [action] = await sql<{ status: string; reviewed_by: string }[]>`
        select status, reviewed_by::text from ai_actions where id = ${aiActionId}::bigint
      `;
      expect(action!.status).toBe("rejected");
      expect(action!.reviewed_by).toBe(OWNER_ID);

      delete process.env["ANTHROPIC_API_KEY"];
    });

    it("listAiActions が履歴一覧を返す", async () => {
      mockAuth.session = ownerSession;

      const result = await listAiActions(100);
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 権限チェック: reception は承認できない
  // -----------------------------------------------------------------------
  describe("権限チェック", () => {
    it("reception は approveAiAction が拒否される", async () => {
      mockAuth.session = { userId: OWNER_ID, role: "reception" };

      const result = await approveAiAction("1");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/owner|admin/i);
    });

    it("reception は rejectAiAction が拒否される", async () => {
      mockAuth.session = { userId: OWNER_ID, role: "reception" };

      const result = await rejectAiAction("1");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/owner|admin/i);
    });
  });

  // -----------------------------------------------------------------------
  // suggestBannedWordRewrite: キー未設定でも detected を返す
  // -----------------------------------------------------------------------
  describe("suggestBannedWordRewrite: 禁止語検出（AI 非依存）", () => {
    it("禁止語の検出は AI なしでも動く（checkBannedWords で先に検出）", async () => {
      delete process.env["ANTHROPIC_API_KEY"];

      const result = await suggestBannedWordRewrite({
        text: "マッサージが得意です",
        bannedWords: ["マッサージ"],
      });

      // キー未設定・禁止語あり → ok:false だが detected 情報はエラーメッセージに含まれる
      // または ok:true で detected が返る（禁止語なしなら ok:true で通る）
      // ここでは禁止語あり＋キー未設定 → ok:false
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/マッサージ|AI|未設定/);
      }
    });

    it("禁止語なし → ok:true でそのまま返る（AI 呼ばない）", async () => {
      delete process.env["ANTHROPIC_API_KEY"];

      const result = await suggestBannedWordRewrite({
        text: "リラクゼーションが得意です",
        bannedWords: ["マッサージ"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.detected).toHaveLength(0);
        expect(result.suggestion).toBe("リラクゼーションが得意です");
      }
    });
  });
});
