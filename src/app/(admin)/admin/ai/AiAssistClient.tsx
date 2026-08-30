"use client";

/**
 * AI アシスタント クライアントコンポーネント（フェーズ21 / spec 19章）。
 *
 * 安全ゲートを UI で体現:
 * - 「下書きに反映（承認）」ボタンはあるが「公開」ボタンは無い（AI は公開できない）
 * - 承認/却下は owner/admin のみ（フォームで制御・サーバ側でも検証）
 * - 提案を表示するだけで、承認前は何もドラフトに書かない
 */

import { useState, useTransition } from "react";
import {
  runAiAssist,
  approveAiAction,
  rejectAiAction,
  listAiActions,
} from "@/lib/ai/actions";
import type { AiActionListItem, AiActionType, AiAssistOutput } from "@/lib/ai/actions";

type GenerateKind =
  | "profile"
  | "catch"
  | "news"
  | "faq_answer"
  | "seo_title"
  | "seo_description"
  | "rewrite";

interface Props {
  initialActions: AiActionListItem[];
  /** owner または admin のみ承認/却下ボタンを表示 */
  canApprove: boolean;
}

const ACTION_TYPE_LABELS: Record<AiActionType, string> = {
  generate: "下書き生成",
  rewrite: "リライト・トーン調整",
  banned_word_suggest: "禁止語言い換え",
  terminology_suggest: "用語統一",
  structure_change: "構造変更提案",
};

const STATUS_LABELS: Record<string, string> = {
  proposed: "提案中",
  approved: "承認済み（下書きに反映）",
  rejected: "却下",
  failed: "失敗",
};

const STATUS_COLORS: Record<string, string> = {
  proposed: "text-[#C98A2B] bg-[#C98A2B]/10",
  approved: "text-[#3F7A6B] bg-[#3F7A6B]/10",
  rejected: "text-[#B4453C] bg-[#B4453C]/10",
  failed: "text-[#B4453C] bg-[#B4453C]/10",
};

const KIND_LABELS: Record<GenerateKind, string> = {
  profile: "プロフィール文",
  catch: "キャッチコピー",
  news: "お知らせ文",
  faq_answer: "FAQ回答",
  seo_title: "SEOタイトル",
  seo_description: "SEOディスクリプション",
  rewrite: "リライト",
};

export default function AiAssistClient({ initialActions, canApprove }: Props) {
  const [actions, setActions] = useState<AiActionListItem[]>(initialActions);
  const [tab, setTab] = useState<"generate" | "banned" | "term" | "history">("generate");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // フォーム: 下書き生成・リライト
  const [genKind, setGenKind] = useState<GenerateKind>("profile");
  const [genActionType, setGenActionType] = useState<"generate" | "rewrite">("generate");
  const [genEntity, setGenEntity] = useState("");
  const [genFieldKey, setGenFieldKey] = useState("");
  const [genContext, setGenContext] = useState("");
  const [genInstruction, setGenInstruction] = useState("");
  const [genResult, setGenResult] = useState<AiAssistOutput | null>(null);

  // フォーム: 禁止語言い換え
  const [bannedText, setBannedText] = useState("");
  const [bannedWords, setBannedWords] = useState("");
  const [bannedResult, setBannedResult] = useState<AiAssistOutput | null>(null);

  // フォーム: 用語統一
  const [termText, setTermText] = useState("");
  const [termDictJson, setTermDictJson] = useState("");
  const [termResult, setTermResult] = useState<AiAssistOutput | null>(null);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  const refreshHistory = () => {
    startTransition(async () => {
      const res = await listAiActions(50);
      if (res.ok && res.data) setActions(res.data);
    });
  };

  // 下書き生成 / リライト 実行
  const handleGenerate = () => {
    setError(null);
    setGenResult(null);
    startTransition(async () => {
      const res = await runAiAssist({
        actionType: genActionType,
        entity: genEntity || undefined,
        request: {
          kind: genKind,
          context: genContext || undefined,
          instruction: genInstruction || undefined,
          fieldKey: genFieldKey || undefined,
        },
      });
      if (!res.ok) {
        setError(res.error ?? "エラーが発生しました");
        return;
      }
      if (res.data) setGenResult(res.data);
      refreshHistory();
    });
  };

  // 禁止語言い換え実行
  const handleBannedWord = () => {
    setError(null);
    setBannedResult(null);
    startTransition(async () => {
      const words = bannedWords
        .split(/[,、\n]/)
        .map((w) => w.trim())
        .filter(Boolean);
      const res = await runAiAssist({
        actionType: "banned_word_suggest",
        request: { text: bannedText, bannedWords: words },
      });
      if (!res.ok) {
        setError(res.error ?? "エラーが発生しました");
        return;
      }
      if (res.data) setBannedResult(res.data);
      refreshHistory();
    });
  };

  // 用語統一実行
  const handleTerminology = () => {
    setError(null);
    setTermResult(null);
    startTransition(async () => {
      let terminology: Array<{ key: string; value: string }> = [];
      try {
        terminology = JSON.parse(termDictJson || "[]") as typeof terminology;
      } catch {
        setError("用語辞書の JSON が正しくありません");
        return;
      }
      const res = await runAiAssist({
        actionType: "terminology_suggest",
        request: { text: termText, terminology },
      });
      if (!res.ok) {
        setError(res.error ?? "エラーが発生しました");
        return;
      }
      if (res.data) setTermResult(res.data);
      refreshHistory();
    });
  };

  // 承認
  const handleApprove = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await approveAiAction(id);
      if (!res.ok) {
        setError(res.error ?? "承認に失敗しました");
        return;
      }
      showSuccess("下書きに反映しました（公開には別途「公開」操作が必要です）");
      refreshHistory();
    });
  };

  // 却下
  const handleReject = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await rejectAiAction(id);
      if (!res.ok) {
        setError(res.error ?? "却下に失敗しました");
        return;
      }
      showSuccess("却下しました");
      refreshHistory();
    });
  };

  return (
    <div className="space-y-6">
      {/* トースト */}
      {successMsg && (
        <div className="fixed top-4 right-4 z-50 bg-[#3F7A6B] text-white px-4 py-3 rounded text-sm shadow-sm" role="status">
          {successMsg}
        </div>
      )}

      {/* エラー */}
      {error && (
        <div className="bg-[#B4453C]/10 border border-[#B4453C]/30 text-[#B4453C] px-4 py-3 rounded text-sm" role="alert">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>閉じる</button>
        </div>
      )}

      {/* 注意書き */}
      <div className="bg-[#C98A2B]/10 border border-[#C98A2B]/30 rounded p-3 text-sm text-[#C98A2B]">
        AIの出力は必ず「提案」です。承認しないとドラフトに反映されません。
        また、ドラフトへの反映後も別途「公開」操作が必要です。AIが直接公開することはありません。
      </div>

      {/* タブ */}
      <div className="flex gap-1 border-b border-[#DFE3DE]">
        {(
          [
            { key: "generate", label: "生成・リライト" },
            { key: "banned", label: "禁止語言い換え" },
            { key: "term", label: "用語統一" },
            { key: "history", label: "操作履歴" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === t.key
                ? "border-[#3F7A6B] text-[#3F7A6B]"
                : "border-transparent text-[#1C2321]/60 hover:text-[#1C2321]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 下書き生成・リライト */}
      {tab === "generate" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">操作種別</label>
              <select
                value={genActionType}
                onChange={(e) => setGenActionType(e.target.value as "generate" | "rewrite")}
                className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm bg-white"
              >
                <option value="generate">下書き生成</option>
                <option value="rewrite">リライト・トーン調整</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">コンテンツ種別</label>
              <select
                value={genKind}
                onChange={(e) => setGenKind(e.target.value as GenerateKind)}
                className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm bg-white"
              >
                {Object.entries(KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">
                対象 entity（例: record:therapist:aoi）
                <span className="text-[#1C2321]/40 ml-1 font-normal">承認時の反映先</span>
              </label>
              <input
                value={genEntity}
                onChange={(e) => setGenEntity(e.target.value)}
                placeholder="省略可（反映先なし = 提案のみ）"
                className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">フィールドキー（承認時の書き込み先）</label>
              <input
                value={genFieldKey}
                onChange={(e) => setGenFieldKey(e.target.value)}
                placeholder="例: profile_text"
                className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">既存テキスト（リライト元・文脈）</label>
            <textarea
              value={genContext}
              onChange={(e) => setGenContext(e.target.value)}
              rows={4}
              placeholder="既存のテキストを貼り付けてください（省略可）"
              className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">追加指示（任意）</label>
            <input
              value={genInstruction}
              onChange={(e) => setGenInstruction(e.target.value)}
              placeholder="例: 明るくフレンドリーなトーンで"
              className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm"
            />
          </div>

          <button
            onClick={handleGenerate}
            disabled={isPending}
            className="bg-[#3F7A6B] text-white px-6 py-2 rounded text-sm hover:bg-[#3F7A6B]/90 disabled:opacity-50 transition-colors"
          >
            {isPending ? "生成中..." : "AIに下書きを依頼"}
          </button>

          {/* 提案表示 */}
          {genResult && (
            <AiProposalCard
              result={genResult}
              canApprove={canApprove}
              onApprove={handleApprove}
              onReject={handleReject}
              isPending={isPending}
            />
          )}
        </div>
      )}

      {/* 禁止語言い換え */}
      {tab === "banned" && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">チェック対象テキスト</label>
            <textarea
              value={bannedText}
              onChange={(e) => setBannedText(e.target.value)}
              rows={5}
              className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              禁止語リスト（カンマ・改行区切り）
            </label>
            <textarea
              value={bannedWords}
              onChange={(e) => setBannedWords(e.target.value)}
              rows={3}
              placeholder="マッサージ, 治療, 医療..."
              className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={handleBannedWord}
            disabled={isPending || !bannedText.trim()}
            className="bg-[#3F7A6B] text-white px-6 py-2 rounded text-sm hover:bg-[#3F7A6B]/90 disabled:opacity-50 transition-colors"
          >
            {isPending ? "処理中..." : "禁止語をチェック・言い換え提案"}
          </button>

          {bannedResult && (
            <AiBannedWordResult result={bannedResult} />
          )}
        </div>
      )}

      {/* 用語統一 */}
      {tab === "term" && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">対象テキスト</label>
            <textarea
              value={termText}
              onChange={(e) => setTermText(e.target.value)}
              rows={5}
              className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              用語辞書（JSON: {"[{\"key\": \"...\", \"value\": \"...\"}]"}）
            </label>
            <textarea
              value={termDictJson}
              onChange={(e) => setTermDictJson(e.target.value)}
              rows={4}
              placeholder={'[{"key": "service_noun", "value": "リラクゼーション"}]'}
              className="w-full border border-[#DFE3DE] rounded px-3 py-2 text-sm font-mono text-xs"
            />
          </div>
          <button
            onClick={handleTerminology}
            disabled={isPending || !termText.trim()}
            className="bg-[#3F7A6B] text-white px-6 py-2 rounded text-sm hover:bg-[#3F7A6B]/90 disabled:opacity-50 transition-colors"
          >
            {isPending ? "処理中..." : "用語統一を提案"}
          </button>

          {termResult && (
            <AiTermResult result={termResult} />
          )}
        </div>
      )}

      {/* 操作履歴 */}
      {tab === "history" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[#1C2321]/60">{actions.length} 件</p>
            <button
              onClick={refreshHistory}
              disabled={isPending}
              className="text-sm text-[#3F7A6B] hover:underline disabled:opacity-50"
            >
              更新
            </button>
          </div>

          {actions.length === 0 && (
            <div className="text-center py-12 text-[#1C2321]/40 text-sm">
              AI操作の履歴はありません
            </div>
          )}

          {actions.map((action) => (
            <div key={action.id} className="border border-[#DFE3DE] rounded p-4 space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {ACTION_TYPE_LABELS[action.action_type]}
                  </span>
                  {action.entity && (
                    <span className="text-xs text-[#1C2321]/40 font-mono">
                      {action.entity}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${STATUS_COLORS[action.status] ?? ""}`}
                  >
                    {STATUS_LABELS[action.status] ?? action.status}
                  </span>
                  <span className="text-xs text-[#1C2321]/40">
                    {action.created_at.slice(0, 16).replace("T", " ")}
                  </span>
                </div>
              </div>

              {action.created_by_name && (
                <p className="text-xs text-[#1C2321]/40">
                  依頼: {action.created_by_name}
                  {action.reviewed_by_name && ` / 審査: ${action.reviewed_by_name}`}
                </p>
              )}

              {/* AI 出力プレビュー（proposed のみ展開可能にする） */}
              {action.output && action.status === "proposed" && canApprove && (
                <div className="border-t border-[#DFE3DE] pt-2 space-y-2">
                  <pre className="text-xs text-[#1C2321]/70 whitespace-pre-wrap bg-[#F6F7F5] rounded p-2 max-h-40 overflow-y-auto">
                    {JSON.stringify(action.output, null, 2)}
                  </pre>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApprove(action.id)}
                      disabled={isPending}
                      className="text-xs bg-[#3F7A6B] text-white px-3 py-1 rounded hover:bg-[#3F7A6B]/90 disabled:opacity-50 transition-colors"
                    >
                      下書きに反映（承認）
                    </button>
                    <button
                      onClick={() => handleReject(action.id)}
                      disabled={isPending}
                      className="text-xs border border-[#B4453C] text-[#B4453C] px-3 py-1 rounded hover:bg-[#B4453C]/10 disabled:opacity-50 transition-colors"
                    >
                      却下
                    </button>
                  </div>
                  <p className="text-xs text-[#1C2321]/40">
                    ※ 「公開」ボタンはありません。AIが直接公開することはできません。
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// サブコンポーネント
// ---------------------------------------------------------------------------

function AiProposalCard({
  result,
  canApprove,
  onApprove,
  onReject,
  isPending,
}: {
  result: AiAssistOutput;
  canApprove: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  isPending: boolean;
}) {
  const draft = (result.output as { draft?: string }).draft ?? JSON.stringify(result.output, null, 2);

  return (
    <div className="border border-[#DFE3DE] rounded p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">AI の提案</h3>
        {result.detectedBannedWords && result.detectedBannedWords.length > 0 && (
          <span className="text-xs bg-[#C98A2B]/10 text-[#C98A2B] px-2 py-0.5 rounded">
            禁止語を検出: {result.detectedBannedWords.join("、")}
          </span>
        )}
      </div>

      <pre className="text-sm whitespace-pre-wrap bg-[#F6F7F5] rounded p-3 max-h-64 overflow-y-auto border border-[#DFE3DE]">
        {draft}
      </pre>

      {canApprove && (
        <div className="flex gap-2">
          <button
            onClick={() => onApprove(result.aiActionId)}
            disabled={isPending}
            className="bg-[#3F7A6B] text-white px-4 py-2 rounded text-sm hover:bg-[#3F7A6B]/90 disabled:opacity-50 transition-colors"
          >
            下書きに反映（承認）
          </button>
          <button
            onClick={() => onReject(result.aiActionId)}
            disabled={isPending}
            className="border border-[#B4453C] text-[#B4453C] px-4 py-2 rounded text-sm hover:bg-[#B4453C]/10 disabled:opacity-50 transition-colors"
          >
            却下
          </button>
          <p className="text-xs text-[#1C2321]/40 self-center">
            ※ 承認しても「公開」は別途必要です。AIが直接公開することはありません。
          </p>
        </div>
      )}

      {!canApprove && (
        <p className="text-xs text-[#C98A2B]">
          承認・却下は owner または admin のみ実行できます
        </p>
      )}
    </div>
  );
}

function AiBannedWordResult({ result }: { result: AiAssistOutput }) {
  const output = result.output as { detected?: string[]; suggestion?: string };
  return (
    <div className="border border-[#DFE3DE] rounded p-4 space-y-3">
      <h3 className="text-sm font-medium">禁止語チェック結果</h3>
      {output.detected && output.detected.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {output.detected.map((w) => (
              <span key={w} className="text-xs bg-[#B4453C]/10 text-[#B4453C] px-2 py-0.5 rounded">
                {w}
              </span>
            ))}
          </div>
          <div>
            <p className="text-xs font-medium text-[#1C2321]/60 mb-1">言い換え案</p>
            <pre className="text-sm whitespace-pre-wrap bg-[#F6F7F5] rounded p-3 border border-[#DFE3DE]">
              {output.suggestion}
            </pre>
          </div>
        </div>
      ) : (
        <p className="text-sm text-[#3F7A6B]">禁止語は検出されませんでした</p>
      )}
    </div>
  );
}

function AiTermResult({ result }: { result: AiAssistOutput }) {
  const output = result.output as { suggestion?: string; changes?: string[] };
  return (
    <div className="border border-[#DFE3DE] rounded p-4 space-y-3">
      <h3 className="text-sm font-medium">用語統一案</h3>
      {output.changes && output.changes.length > 0 && (
        <ul className="text-xs space-y-1 text-[#1C2321]/60">
          {output.changes.map((c, i) => (
            <li key={i} className="flex gap-1">
              <span className="text-[#3F7A6B]">-</span> {c}
            </li>
          ))}
        </ul>
      )}
      <pre className="text-sm whitespace-pre-wrap bg-[#F6F7F5] rounded p-3 border border-[#DFE3DE] max-h-64 overflow-y-auto">
        {output.suggestion}
      </pre>
    </div>
  );
}
