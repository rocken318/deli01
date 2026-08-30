import type { Metadata } from "next";
import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import { listAiActions } from "@/lib/ai/actions";
import AiAssistClient from "./AiAssistClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AIアシスタント",
};

export default async function AiAssistPage() {
  const session = await getDevSession();

  // 認証チェック
  if (!session) {
    return (
      <div className="text-center py-16 text-[#1C2321]/60">
        <p className="text-sm">ログインが必要です</p>
      </div>
    );
  }

  const actor = toActor(session);
  const isStaff =
    actor.role === "owner" || actor.role === "admin" || actor.role === "reception";

  if (!isStaff) {
    return (
      <div className="text-center py-16 text-[#1C2321]/60">
        <p className="text-sm">この画面へのアクセス権がありません</p>
      </div>
    );
  }

  // 初期履歴を取得
  const actionsResult = await listAiActions(50);
  const initialActions = actionsResult.ok && actionsResult.data ? actionsResult.data : [];

  const canApprove = can(actor, "manage_cms");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[#1C2321]">AIアシスタント</h1>
        <p className="text-sm text-[#1C2321]/60 mt-1">
          AI が下書きを提案します。承認しないとドラフトに反映されません。AIが公開することはありません。
        </p>
      </div>

      <AiAssistClient
        initialActions={initialActions}
        canApprove={canApprove}
      />
    </div>
  );
}
