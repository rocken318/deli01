"use client";

import { useState, useTransition } from "react";
import type {
  PublicArea,
  PublicCourse,
  PublicOption,
  PublicSlotView,
} from "@/lib/availability/public-slots";
import { recomputeSlots } from "./slots-actions";

/**
 * 空き枠パネル（spec 2-3 ★）。エリア・コース・オプションを選ぶと**都度再計算**し、
 * 候補枠（帯/リスト）が入れ替わる（これがフェーズ10 の完了条件）。
 *
 * - 初期枠はサーバ側（page.tsx）で計算済みの値を受け取り、変更時のみ Server Action。
 * - キャッシュしない（Server Action が毎回 computeAvailableSlots を回す / spec 2-7）。
 * - 「〇〇区であれば案内可能」の前提（assumed=true のとき areaName 条件）を明記。
 * - 文言はすべて props（content 由来）。日本語リテラルを持たない。
 * - 空/ローディング/エラーの3状態（spec 12-3）。キーボード操作可。
 */

export interface AvailabilityLabels {
  /** 「エリアで絞り込む」見出し */
  areaHeading: string;
  /** 「すべて」相当（未指定=代表エリア概算に戻す） */
  areaAll: string;
  /** コース選択見出し */
  courseHeading: string;
  /** オプション選択見出し */
  optionHeading: string;
  /** 空き枠セクション見出し */
  slotsHeading: string;
  /** 「〇〇区であれば案内可能」テンプレ（{area} を areaName で差し替え） */
  conditionTemplate: string;
  /** 概算の前提注記（エリア未指定時の「代表エリアの概算」注意） */
  assumedNote: string;
  /** 枠が無いときの見出し */
  emptyTitle: string;
  /** 枠が無いときの本文 */
  emptyBody: string;
  /** 再計算中 */
  loading: string;
  /** 失敗時 */
  error: string;
  /** 枠を押すと予約導線へ（現状は導線ラベルのみ） */
  slotAria: string;
}

interface SlotsState {
  slots: PublicSlotView[];
  areaName: string;
  assumed: boolean;
  ok: boolean;
}

export function AvailabilityPanel({
  slug,
  dateISO,
  areas,
  courses,
  options,
  initialSlots,
  initialAreaId,
  initialAreaName,
  initialAssumed,
  bookingHref,
  labels,
}: {
  slug: string;
  dateISO: string;
  areas: PublicArea[];
  courses: PublicCourse[];
  options: PublicOption[];
  initialSlots: PublicSlotView[];
  initialAreaId: string | null;
  initialAreaName: string;
  initialAssumed: boolean;
  bookingHref: string;
  labels: AvailabilityLabels;
}) {
  const [areaId, setAreaId] = useState<string | null>(initialAreaId);
  const [courseId, setCourseId] = useState<string | null>(courses[0]?.id ?? null);
  const [optionIds, setOptionIds] = useState<string[]>([]);
  const [state, setState] = useState<SlotsState>({
    slots: initialSlots,
    areaName: initialAreaName,
    assumed: initialAssumed,
    ok: true,
  });
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  const refresh = (next: {
    areaId: string | null;
    courseId: string | null;
    optionIds: string[];
  }) => {
    setFailed(false);
    startTransition(async () => {
      try {
        const res = await recomputeSlots({
          slug,
          dateISO,
          areaId: next.areaId,
          courseId: next.courseId,
          optionIds: next.optionIds,
        });
        if (!res.ok) {
          setFailed(true);
          return;
        }
        setState({
          slots: res.slots,
          areaName: res.areaName,
          assumed: res.assumed,
          ok: res.ok,
        });
      } catch {
        setFailed(true);
      }
    });
  };

  const chooseArea = (id: string | null) => {
    setAreaId(id);
    refresh({ areaId: id, courseId, optionIds });
  };
  const chooseCourse = (id: string) => {
    setCourseId(id);
    refresh({ areaId, courseId: id, optionIds });
  };
  const toggleOption = (id: string) => {
    const next = optionIds.includes(id)
      ? optionIds.filter((o) => o !== id)
      : [...optionIds, id];
    setOptionIds(next);
    refresh({ areaId, courseId, optionIds: next });
  };

  const condition =
    state.areaName && labels.conditionTemplate
      ? labels.conditionTemplate.replace("{area}", state.areaName)
      : "";

  return (
    <div className="space-y-6">
      {/* エリア選択（チップ。名前は DB 由来） */}
      {areas.length > 0 && (
        <section aria-label={labels.areaHeading || undefined}>
          {labels.areaHeading && (
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
              {labels.areaHeading}
            </h3>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label={labels.areaHeading || undefined}>
            {labels.areaAll && (
              <button
                type="button"
                onClick={() => chooseArea(null)}
                aria-pressed={areaId === null}
                className={chipClass(areaId === null)}
              >
                {labels.areaAll}
              </button>
            )}
            {areas.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => chooseArea(a.id)}
                aria-pressed={areaId === a.id}
                className={chipClass(areaId === a.id)}
              >
                {a.name}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* コース選択（名前・時間・金額は DB 由来） */}
      {courses.length > 0 && (
        <section aria-label={labels.courseHeading || undefined}>
          {labels.courseHeading && (
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
              {labels.courseHeading}
            </h3>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label={labels.courseHeading || undefined}>
            {courses.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => chooseCourse(c.id)}
                aria-pressed={courseId === c.id}
                className={chipClass(courseId === c.id)}
              >
                <span>{c.name}</span>
                <span className="ml-2 font-mono text-xs tabular-nums opacity-80">
                  {c.durationMin}
                  {"m"}
                </span>
                <span className="ml-1 font-mono text-xs tabular-nums opacity-80">
                  {"¥"}
                  {c.price.toLocaleString("en-US")}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* オプション選択（時間が伸びると枠が後ろにずれる / spec 3-4・5-3） */}
      {options.length > 0 && (
        <section aria-label={labels.optionHeading || undefined}>
          {labels.optionHeading && (
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
              {labels.optionHeading}
            </h3>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label={labels.optionHeading || undefined}>
            {options.map((o) => {
              const on = optionIds.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => toggleOption(o.id)}
                  aria-pressed={on}
                  className={chipClass(on)}
                >
                  <span>{o.name}</span>
                  {o.durationMin > 0 && (
                    <span className="ml-2 font-mono text-xs tabular-nums opacity-80">
                      {"+"}
                      {o.durationMin}
                      {"m"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* 空き枠（帯/リスト） */}
      <section aria-label={labels.slotsHeading || undefined} aria-busy={pending}>
        <div className="mb-2 flex items-center justify-between gap-2">
          {labels.slotsHeading && (
            <h3 className="text-xs font-medium uppercase tracking-wide text-pub-subtext">
              {labels.slotsHeading}
            </h3>
          )}
          {pending && labels.loading && (
            <span className="text-xs text-pub-subtext" role="status">
              {labels.loading}
            </span>
          )}
        </div>

        {/* 前提つき表示（「〇〇区であれば案内可能」/ spec 2-3） */}
        {condition && (
          <p className="mb-3 text-sm text-pub-subtext">
            {condition}
            {state.assumed && labels.assumedNote && (
              <span className="ml-1 text-xs text-pub-subtext/80">{labels.assumedNote}</span>
            )}
          </p>
        )}

        {failed ? (
          <p className="rounded border border-pub-border bg-pub-surface px-4 py-6 text-center text-sm text-pub-subtext" role="alert">
            {labels.error}
          </p>
        ) : state.slots.length === 0 ? (
          <div className="rounded border border-pub-border bg-pub-surface px-4 py-8 text-center">
            {labels.emptyTitle && (
              <p className="font-heading text-base text-pub-text">{labels.emptyTitle}</p>
            )}
            {labels.emptyBody && (
              <p className="mt-1 text-sm text-pub-subtext">{labels.emptyBody}</p>
            )}
          </div>
        ) : (
          <ul className={`flex flex-wrap gap-2 ${pending ? "opacity-60" : ""}`}>
            {state.slots.map((s) => (
              <li key={s.startAtISO}>
                <a
                  href={bookingHref}
                  aria-label={labels.slotAria ? `${labels.slotAria} ${s.time}` : s.time}
                  className="inline-block rounded border border-pub-primary/50 bg-pub-primary/10 px-3 py-1.5 font-mono text-base font-medium tabular-nums text-pub-primary transition-colors hover:bg-pub-primary hover:text-pub-bg focus-visible:bg-pub-primary focus-visible:text-pub-bg"
                >
                  {s.time}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function chipClass(active: boolean): string {
  return `rounded border px-3 py-1.5 text-sm transition-colors ${
    active
      ? "border-pub-primary bg-pub-primary text-pub-bg"
      : "border-pub-border text-pub-text hover:border-pub-primary"
  }`;
}
