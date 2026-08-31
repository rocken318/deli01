"use client";

/**
 * ヒーロー直下（スマホ）に置く「下へスクロール」ボタン。
 * タップで1画面ぶん下へスムーズスクロールし、本文へ誘導する。
 * スマホ限定（md 未満のみ表示）＝PC のレイアウトには影響しない。
 * 文言は用語辞書経由で受け取る（公開側テンプレに直書きしない / spec 13-1）。
 */
export function HeroScrollButton({ label }: { label: string }) {
  const onClick = () => {
    if (typeof window === "undefined") return;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "smooth" });
  };

  return (
    <div className="flex justify-center md:hidden -mt-2 pb-4">
      <button
        type="button"
        onClick={onClick}
        aria-label={label || "scroll down"}
        className="group flex flex-col items-center gap-1 rounded-full px-5 py-2 text-pub-accent transition-opacity hover:opacity-80"
        style={{ border: "1px solid rgba(198,161,91,0.5)", background: "rgba(21,26,32,0.6)" }}
      >
        {label && <span className="text-xs tracking-wider">{label}</span>}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-bounce"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}
