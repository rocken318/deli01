"use client";

import { useEffect } from "react";
import { trackFunnel } from "../booking/actions";
import { getFunnelSessionId } from "./funnel-session";

/**
 * ファネル計測の発火コンポーネント（付録B-2）。マウント時に1回だけ
 * 指定ステップを記録する。描画は無し（計測のみ）。
 * 例: セラピスト個人ページに <FunnelPing step="view_therapist" slug={slug} />。
 */
export function FunnelPing({
  step,
  slug,
}: {
  step: "visit" | "view_therapist";
  slug?: string;
}) {
  useEffect(() => {
    const sessionId = getFunnelSessionId();
    if (!sessionId) return;
    void trackFunnel({
      sessionId,
      step,
      therapistSlug: slug ?? null,
    });
  }, [step, slug]);
  return null;
}
