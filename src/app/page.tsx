/**
 * フェーズ0の暫定トップ。公開トップ（spec 2-1）はフェーズ5で public-ui が実装する。
 * ここでは基盤が立ち上がっていることを示すだけの最小表示に留める。
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[375px] flex-col justify-center gap-4 px-6 py-16">
      <p className="font-mono text-sm text-pub-accent">deli01 · phase 0</p>
      <h1 className="font-heading text-2xl leading-relaxed text-pub-text">
        基盤の立ち上げ
      </h1>
      <p className="text-sm leading-relaxed text-pub-subtext">
        リポジトリ・CI・DB（PostGIS）・シードの土台。公開ページは後続フェーズで実装します。
      </p>
      <div className="mt-4 rounded border border-pub-border bg-pub-surface p-4">
        <p className="font-mono text-lg text-pub-primary">最短 --:-- から案内可能</p>
        <p className="mt-1 text-xs text-pub-subtext">
          ※ 空き枠エンジン（spec 5章 / フェーズ9）実装後に稼働
        </p>
      </div>
    </main>
  );
}
