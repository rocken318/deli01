"use client";

/**
 * ヒーロー画像内（スマホ）に重ねる「scroll」誘導。
 * 画像下部（「今宵はいかがなさいますか？」の下・下から約1/4）に絶対配置し、
 * タップで1画面ぶん下へスムーズスクロールする。
 * スマホ限定（md 未満のみ表示）＝PC のレイアウトには影響しない。
 * 文言は英語「scroll」（公開側テンプレに直書き日本語を置かない / spec 13-1）。
 */
export function HeroScrollButton() {
  const onClick = () => {
    if (typeof window === "undefined") return;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "smooth" });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="scroll down"
      className="absolute left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1 text-pub-accent transition-opacity hover:opacity-80 md:hidden"
      style={{ bottom: "25%" }}
    >
      <span className="text-sm tracking-[0.3em] uppercase">scroll</span>
      <svg
        width="24"
        height="24"
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
  );
}
