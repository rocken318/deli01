"use client";

export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // notFound()/redirect()（digest が NEXT_*）は再スローして Next に処理させる。
  if (error?.digest?.startsWith("NEXT_")) throw error;
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 px-5 py-12">
      <p className="text-pub-subtext" role="status">
        ↻
      </p>
      <button
        type="button"
        aria-label="Retry"
        onClick={reset}
        className="rounded border border-pub-border px-6 py-2 text-pub-text hover:border-pub-primary hover:text-pub-primary"
      >
        ↻
      </button>
    </div>
  );
}
