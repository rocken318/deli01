"use client";

import { useMemo, useState } from "react";
import type { TherapistCardView } from "@/lib/public/therapist-view";
import { TherapistCard } from "../_components/therapist-card";
import { EmptyState } from "../_components/empty-state";

/**
 * 一覧の絞り込み UI（spec 2-4）。得意な施術タグで絞る（is_filterable な
 * field_definition 由来の choices）。データが揃う範囲で提供し、エリア/日時は
 * フェーズ6-8 実装後に拡張する枠を用意する。
 *
 * 文言はすべて props（content レイヤ由来）。日本語リテラルを持たない。
 * クライアント側での絞り込みは published カードデータのみを対象にする。
 */
export function TherapistFilter({
  cards,
  tagChoices,
  labels,
}: {
  cards: TherapistCardView[];
  tagChoices: string[];
  labels: {
    filterHeading: string;
    filterAllTags: string;
    detailCta: string;
    earliestTemplate: string;
    earliestPending: string;
    emptyTitle: string;
    emptyBody: string;
  };
}) {
  const [activeTags, setActiveTags] = useState<string[]>([]);

  const toggle = (tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const filtered = useMemo(() => {
    if (activeTags.length === 0) return cards;
    return cards.filter((c) => activeTags.every((t) => c.goodAtTags.includes(t)));
  }, [cards, activeTags]);

  return (
    <div className="space-y-6">
      {tagChoices.length > 0 && (
        <div className="rounded border border-pub-border bg-pub-surface p-4">
          {labels.filterHeading && (
            <p className="mb-3 text-sm text-pub-subtext">{labels.filterHeading}</p>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label={labels.filterHeading || undefined}>
            <button
              type="button"
              onClick={() => setActiveTags([])}
              aria-pressed={activeTags.length === 0}
              className={`rounded border px-3 py-1.5 text-sm transition-colors ${
                activeTags.length === 0
                  ? "border-pub-primary bg-pub-primary text-pub-bg"
                  : "border-pub-border text-pub-text hover:border-pub-primary"
              }`}
            >
              {labels.filterAllTags}
            </button>
            {tagChoices.map((tag) => {
              const on = activeTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggle(tag)}
                  aria-pressed={on}
                  className={`rounded border px-3 py-1.5 text-sm transition-colors ${
                    on
                      ? "border-pub-primary bg-pub-primary text-pub-bg"
                      : "border-pub-border text-pub-text hover:border-pub-primary"
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState title={labels.emptyTitle} body={labels.emptyBody} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {filtered.map((card) => (
            <li key={card.slug}>
              <TherapistCard
                card={card}
                detailLabel={labels.detailCta}
                earliestTemplate={labels.earliestTemplate}
                earliestPending={labels.earliestPending}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
