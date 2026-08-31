"use client";

/**
 * ヒーロー直下（スマホ）に置く「下へスクロール」ボタン。
 * タップで1画面ぶん下へスムーズスクロールし、本文へ誘導する。
 * スマホ限定（md 未満のみ表示）＝PC のレイアウトには影響しない。
 * 画像に文言（「今宵はいかがなさいますか？」）が入っているため、ボタンは矢印のみ。
 * aria-label は読み上げ用（英語＝公開側テンプレに直書き日本語を置かない）。
 */
export function HeroScrollButton() {
  const onClick = () => {
    if (typeof window === "undefined") return;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "smooth" });
  };

  return (
    <div className="flex justify-center md:hidden -mt-2 pb-4">
      <button
        type="button"
        onClick={onClick}
        aria-label="scroll down"
        className="flex items-center justify-center rounded-full p-2 text-pub-accent transition-opacity hover:opacity-80"
        style={{ border: "1px solid rgba(198,161,91,0.5)", background: "rgba(21,26,32,0.6)" }}
      >
        <svg
          width="22"
          height="22"
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
