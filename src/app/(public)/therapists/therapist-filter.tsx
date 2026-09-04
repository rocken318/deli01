"use client";

import { useMemo, useState } from "react";
import type { TherapistCardView } from "@/lib/public/therapist-view";
import { TherapistCard } from "../_components/therapist-card";
import { EmptyState } from "../_components/empty-state";

/**
 * 一覧の絞り込み UI（spec 2-4）。得意な施術タグで絞る（is_filterable な
 * field_definition 由来の choices）。エリア絞り込みはサーバ側（page.tsx が
 * URL ?area= で最短案内時刻を再計算）で済ませ、ここには絞り込み後のカードが届く。
 *
 * 各カードは最短案内時刻（earliestTime）と前提注記（conditionNote）を持ち、
 * 署名要素をカード内に出す。文言はすべて props（content レイヤ由来。日本語リテラル無し）。
 */
export interface FilterCard {
  card: TherapistCardView;
  earliestTime: string | null;
  conditionNote: string;
  /** 本日出勤しているか（バッジ表示） */
  workingToday?: boolean;
}

export function TherapistFilter({
  cards,
  tagChoices,
  labels,
}: {
  cards: FilterCard[];
  tagChoices: string[];
  labels: {
    filterHeading: string;
    filterAllTags: string;
    detailCta: string;
    earliestTemplate: string;
    earliestPending: string;
    emptyTitle: string;
    emptyBody: string;
    todayBadge: string;
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
    return cards.filter((c) => activeTags.every((t) => c.card.goodAtTags.includes(t)));
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
          {filtered.map((c) => (
            <li key={c.card.slug}>
              <TherapistCard
                card={c.card}
                detailLabel={labels.detailCta}
                earliestTemplate={labels.earliestTemplate}
                earliestPending={labels.earliestPending}
                earliestTime={c.earliestTime}
                conditionNote={c.conditionNote}
                workingToday={c.workingToday ?? false}
                todayBadgeLabel={labels.todayBadge}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
