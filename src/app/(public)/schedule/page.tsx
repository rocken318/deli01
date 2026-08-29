import type { Metadata } from "next";
import Link from "next/link";
import { getSiteContext, getPublicTherapistFields, label } from "@/lib/public/content";
import type { PublicTherapist } from "@/lib/public/queries";
import { buildTherapistCards } from "@/lib/public/therapist-view";
import { listDailySchedule, listScheduleAreas } from "@/lib/schedule/queries";
import {
  addDaysISO,
  formatShiftTimeRange,
  localDateISO,
  parseDateISO,
  weekdayIndex,
} from "@/domain/availability";
import { EmptyState } from "../_components/empty-state";
import { PublicImage } from "../_components/public-image";

/**
 * 出勤表（spec 2-1 / 2-3 / フェーズ8）。日別に誰が派遣可能かを、エリアで絞って出す。
 *
 * - shifts（保存した瞬間に反映 / spec 3-3）を毎リクエスト読む。force-dynamic で
 *   キャッシュしないため「60秒以内に反映」（フェーズ8完了条件）を実行時読取で満たす。
 * - 出勤していても対応エリア外のセラピストは一覧に出ない（spec 15章）。
 * - 空き枠の確定時刻はフェーズ9-10。ここでは出勤時間帯 + 対応可能表示に留める
 *   （嘘の枠を出さない / spec 2-3）。
 * - 文言は CMS（ui_labels / terminology）・エリア名は DB 由来。直書き日本語ゼロ。
 */
export const dynamic = "force-dynamic";

const DAY_TAB_COUNT = 7;

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await getSiteContext();
  return { title: label(ctx, "schedule_page_title") || ctx.brandName || " " };
}

/** "YYYY-MM-DD" → "M/D"（ロケール非依存の数字表記） */
function monthDayLabel(dateISO: string): string {
  const [, m, d] = dateISO.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function scheduleHref(dateISO: string, areaId: string | null): string {
  const params = new URLSearchParams({ date: dateISO });
  if (areaId) params.set("area", areaId);
  return `/schedule?${params.toString()}`;
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; area?: string }>;
}) {
  const params = await searchParams;
  const today = localDateISO(new Date());
  const requested = parseDateISO(params.date);
  // 表示できるのは今日から2週間先まで（spec 2-3「直近2週間」）。範囲外は今日に丸める
  const maxDate = addDaysISO(today, 13);
  const date = requested && requested >= today && requested <= maxDate ? requested : today;

  const [ctx, fields, areas] = await Promise.all([
    getSiteContext(),
    getPublicTherapistFields(),
    listScheduleAreas(),
  ]);

  const areaId = areas.some((a) => a.id === params.area) ? (params.area ?? null) : null;
  const entries = await listDailySchedule(date, areaId);

  // 写真・キャッチ・タグは一覧カードと同じ組み立て（consent / is_hidden を尊重）
  const asPublicTherapists: PublicTherapist[] = entries.map((e) => ({
    slug: e.slug,
    displayOrder: e.displayOrder,
    published: e.published,
    publishedAt: null,
  }));
  const cards = await buildTherapistCards(asPublicTherapists, fields);
  const cardBySlug = new Map(cards.map((c) => [c.slug, c]));

  const weekdays = label(ctx, "schedule_weekdays").split(",");
  const dayTabs = Array.from({ length: DAY_TAB_COUNT }, (_, i) => addDaysISO(today, i));
  const selectedArea = areaId ? (areas.find((a) => a.id === areaId) ?? null) : null;

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-heading text-2xl text-pub-text">
          {label(ctx, "schedule_page_title")}
        </h1>
        {label(ctx, "schedule_page_lead") && (
          <p className="mt-1 text-sm text-pub-subtext">{label(ctx, "schedule_page_lead")}</p>
        )}
      </header>

      {/* 日付タブ（今日から7日分。2週間分の遷移は前後リンクで足す余地を残す） */}
      <nav
        aria-label={label(ctx, "schedule_date_nav_aria") || "dates"}
        className="-mx-5 mb-4 overflow-x-auto px-5"
      >
        <ul className="flex w-max gap-2 pb-1">
          {dayTabs.map((d) => {
            const active = d === date;
            const wd = weekdays[weekdayIndex(d)] ?? "";
            return (
              <li key={d}>
                <Link
                  href={scheduleHref(d, areaId)}
                  aria-current={active ? "date" : undefined}
                  className={`flex min-w-[3.5rem] flex-col items-center rounded border px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "border-pub-primary bg-pub-primary/10 text-pub-primary"
                      : "border-pub-border bg-pub-surface text-pub-subtext hover:border-pub-primary hover:text-pub-text"
                  }`}
                >
                  <span className="font-mono tabular-nums">{monthDayLabel(d)}</span>
                  {wd && <span className="text-xs">{wd}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* エリア絞り込み（エリア名は DB / spec 3-3「その日に対応できるエリア」） */}
      {areas.length > 0 && (
        <section aria-label={label(ctx, "schedule_area_filter_heading")} className="mb-6">
          {label(ctx, "schedule_area_filter_heading") && (
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
              {label(ctx, "schedule_area_filter_heading")}
            </h2>
          )}
          <ul className="flex flex-wrap gap-2">
            <li>
              <Link
                href={scheduleHref(date, null)}
                aria-current={areaId === null ? "true" : undefined}
                className={`inline-block rounded-full border px-3 py-1 text-sm transition-colors ${
                  areaId === null
                    ? "border-pub-primary bg-pub-primary/10 text-pub-primary"
                    : "border-pub-border text-pub-subtext hover:border-pub-primary hover:text-pub-text"
                }`}
              >
                {label(ctx, "filter_all")}
              </Link>
            </li>
            {areas.map((a) => (
              <li key={a.id}>
                <Link
                  href={scheduleHref(date, a.id)}
                  aria-current={areaId === a.id ? "true" : undefined}
                  className={`inline-block rounded-full border px-3 py-1 text-sm transition-colors ${
                    areaId === a.id
                      ? "border-pub-primary bg-pub-primary/10 text-pub-primary"
                      : "border-pub-border text-pub-subtext hover:border-pub-primary hover:text-pub-text"
                  }`}
                >
                  {a.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 前提つき表示の明記（spec 2-3: 嘘の枠を出さない。確定枠はフェーズ9-10） */}
      {label(ctx, "schedule_disclaimer") && (
        <p className="mb-6 rounded border border-pub-border bg-pub-surface px-4 py-3 text-xs leading-relaxed text-pub-subtext">
          {label(ctx, "schedule_disclaimer")}
        </p>
      )}

      {entries.length === 0 ? (
        <EmptyState
          title={label(ctx, "schedule_empty_title")}
          body={label(ctx, "schedule_empty_body")}
          actionLabel={label(ctx, "view_all_therapists")}
          actionHref="/therapists"
        />
      ) : (
        <ul className="space-y-3">
          {entries.map((e) => {
            const card = cardBySlug.get(e.slug);
            const photo = card?.photo ?? null;
            const showPhoto = photo !== null && photo.faceVisibility !== "none";
            const eyesOverlay = photo !== null && photo.faceVisibility === "eyes";
            const nameRaw = e.published["name"];
            const name = typeof nameRaw === "string" && nameRaw.length > 0 ? nameRaw : e.slug;
            return (
              <li key={e.slug}>
                <Link
                  href={`/therapists/${e.slug}`}
                  className="group flex gap-4 rounded border border-pub-border bg-pub-surface p-4 transition-colors hover:border-pub-primary"
                >
                  <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded bg-pub-bg">
                    {showPhoto ? (
                      <>
                        <PublicImage
                          src={photo.url}
                          alt={photo.alt}
                          width={photo.width ?? 160}
                          height={photo.height ?? 160}
                          className="h-full w-full object-cover"
                          sizes="80px"
                        />
                        {eyesOverlay && (
                          <div
                            className="eye-overlay pointer-events-none absolute inset-0"
                            aria-hidden="true"
                          />
                        )}
                      </>
                    ) : (
                      <div
                        className="flex h-full w-full items-center justify-center"
                        role="img"
                        aria-label="silhouette"
                      >
                        <svg
                          viewBox="0 0 100 120"
                          className="h-1/2 w-1/2 text-pub-border"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <circle cx="50" cy="35" r="20" />
                          <ellipse cx="50" cy="95" rx="35" ry="28" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-heading text-base text-pub-text">{name}</p>
                      {label(ctx, "schedule_available_badge") && (
                        <span className="rounded-full border border-pub-accent/40 bg-pub-accent/10 px-2 py-0.5 text-xs text-pub-accent">
                          {label(ctx, "schedule_available_badge")}
                        </span>
                      )}
                    </div>
                    {/* 出勤時間帯（署名系の等幅・金 / spec 12-1） */}
                    <p className="font-mono text-lg tabular-nums text-pub-primary">
                      {formatShiftTimeRange(e.startAt, e.endAt)}
                    </p>
                    {e.areas.length > 0 && (
                      <ul className="flex flex-wrap gap-1.5">
                        {e.areas.map((a) => (
                          <li
                            key={a.id}
                            className={`rounded border px-2 py-0.5 text-xs ${
                              selectedArea && selectedArea.id === a.id
                                ? "border-pub-primary/60 text-pub-primary"
                                : "border-pub-border text-pub-subtext"
                            }`}
                          >
                            {a.name}
                          </li>
                        ))}
                      </ul>
                    )}
                    {card?.catchCopy && (
                      <p className="truncate text-sm text-pub-subtext">{card.catchCopy}</p>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
