export default function ScheduleLoading() {
  return (
    <div className="mx-auto max-w-3xl animate-pulse px-5 py-8" aria-busy="true">
      <div className="mb-6 h-8 w-40 rounded bg-pub-surface" />
      <div className="mb-4 flex gap-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-12 w-14 rounded bg-pub-surface" />
        ))}
      </div>
      <div className="mb-6 flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-7 w-16 rounded-full bg-pub-surface" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-4 rounded border border-pub-border bg-pub-surface p-4">
            <div className="h-20 w-20 rounded bg-pub-bg" />
            <div className="flex-1 space-y-2 py-1">
              <div className="h-4 w-1/3 rounded bg-pub-bg" />
              <div className="h-5 w-1/2 rounded bg-pub-bg" />
              <div className="h-3 w-2/3 rounded bg-pub-bg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
