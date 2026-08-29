export default function TherapistDetailLoading() {
  return (
    <article className="mx-auto max-w-2xl animate-pulse px-5 py-8" aria-busy="true">
      <div className="mb-6 overflow-hidden rounded border border-pub-border bg-pub-surface">
        <div className="aspect-[4/5] w-full bg-pub-bg" />
      </div>
      <div className="mb-6 space-y-3">
        <div className="h-8 w-2/3 rounded bg-pub-surface" />
        <div className="flex gap-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-5 w-16 rounded bg-pub-surface" />
          ))}
        </div>
        <div className="rounded border border-pub-border bg-pub-surface p-4">
          <div className="h-5 w-48 rounded bg-pub-bg" />
        </div>
      </div>
      <div className="space-y-5 border-t border-pub-border pt-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-3 w-20 rounded bg-pub-surface" />
            <div className="h-5 w-full rounded bg-pub-surface" />
          </div>
        ))}
      </div>
    </article>
  );
}
