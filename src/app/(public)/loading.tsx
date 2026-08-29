export default function PublicLoading() {
  return (
    <div className="mx-auto max-w-3xl animate-pulse px-5 py-8" aria-busy="true">
      <div className="mb-6 h-8 w-48 rounded bg-pub-surface" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded border border-pub-border bg-pub-surface">
            <div className="aspect-[4/5] w-full bg-pub-bg" />
            <div className="space-y-2 p-4">
              <div className="h-4 w-3/4 rounded bg-pub-bg" />
              <div className="h-3 w-1/2 rounded bg-pub-bg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
