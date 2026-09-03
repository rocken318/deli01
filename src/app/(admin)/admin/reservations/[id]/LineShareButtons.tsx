"use client";

/**
 * 予約後 LINE 貼り付け用ボタン（セラピスト向け・ドライバー向け）。
 * spec 12-2 トークン準拠・3状態（取得中/失敗/成功）。
 * クリップボード API 不可環境: モーダルにフォールバック。
 */

import { useState, useTransition } from "react";
import { getBookingShareTexts } from "@/lib/booking/share-texts";

interface Props {
  reservationId: string;
}

interface GeneratedText {
  kind: "therapist" | "driver";
  text: string;
}

export default function LineShareButtons({ reservationId }: Props) {
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fallback, setFallback] = useState<GeneratedText | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleCopy = (kind: "therapist" | "driver") => {
    setErrorMsg(null);
    startTransition(async () => {
      const result = await getBookingShareTexts(reservationId);
      if (!result.ok || !result.data) {
        setErrorMsg(result.error ?? "テキストの生成に失敗しました");
        return;
      }
      const text = kind === "therapist" ? result.data.therapist : result.data.driver;
      let clipOk = false;
      try {
        await navigator.clipboard.writeText(text);
        clipOk = true;
      } catch {
        // クリップボード API 不可 → モーダルフォールバック
      }
      if (clipOk) {
        showToast(
          kind === "therapist"
            ? "セラピスト向けテキストをコピーしました"
            : "ドライバー向けテキストをコピーしました"
        );
      } else {
        setFallback({ kind, text });
      }
    });
  };

  return (
    <>
      {/* トースト */}
      {toast && (
        <div
          className="fixed top-4 right-4 z-50 px-4 py-2 text-sm text-white"
          style={{ background: "#3F7A6B", borderRadius: "4px" }}
        >
          {toast}
        </div>
      )}

      {/* エラー */}
      {errorMsg && (
        <div
          className="text-sm px-3 py-2 mt-2"
          style={{
            border: "1px solid #B4453C",
            color: "#B4453C",
            borderRadius: "4px",
          }}
        >
          {errorMsg}
          <button
            onClick={() => setErrorMsg(null)}
            className="ml-2 underline text-xs"
          >
            閉じる
          </button>
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {/* セラピストにLINE */}
        <button
          onClick={() => handleCopy("therapist")}
          disabled={isPending}
          className="px-3 py-1.5 text-xs border text-adm-text hover:bg-adm-bg transition-colors whitespace-nowrap disabled:opacity-50"
          style={{ borderColor: "#DFE3DE", borderRadius: "4px" }}
        >
          {isPending ? "生成中…" : "セラピストにLINE（コピー）"}
        </button>

        {/* ドライバーにLINE */}
        <button
          onClick={() => handleCopy("driver")}
          disabled={isPending}
          className="px-3 py-1.5 text-xs border text-adm-text hover:bg-adm-bg transition-colors whitespace-nowrap disabled:opacity-50"
          style={{ borderColor: "#DFE3DE", borderRadius: "4px" }}
        >
          {isPending ? "生成中…" : "ドライバーにLINE（コピー）"}
        </button>
      </div>

      {/* フォールバックモーダル */}
      {fallback && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "rgba(0,0,0,0.4)" }}
        >
          <div
            className="bg-white border p-5 w-full max-w-md mx-4"
            style={{ borderColor: "#DFE3DE", borderRadius: "4px" }}
          >
            <h2 className="text-sm font-semibold text-adm-text mb-1">
              {fallback.kind === "therapist"
                ? "セラピスト向けLINEテキスト"
                : "ドライバー向けLINEテキスト"}
            </h2>
            <p className="text-xs text-adm-muted mb-3">
              自動コピーできませんでした。以下を手動でコピーしてください。
            </p>
            <pre
              className="text-sm whitespace-pre-wrap font-mono leading-relaxed max-h-60 overflow-y-auto p-3"
              style={{
                background: "#F6F7F5",
                border: "1px solid #DFE3DE",
                borderRadius: "4px",
              }}
            >
              {fallback.text}
            </pre>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(fallback.text).catch(() => undefined);
                  showToast("コピーしました");
                  setFallback(null);
                }}
                className="flex-1 text-white text-sm font-medium px-3 py-2 hover:opacity-90 transition-opacity"
                style={{ background: "#3F7A6B", borderRadius: "4px" }}
              >
                コピー
              </button>
              <button
                onClick={() => setFallback(null)}
                className="px-3 py-2 text-sm text-adm-text border hover:bg-adm-bg"
                style={{ borderColor: "#DFE3DE", borderRadius: "4px" }}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
