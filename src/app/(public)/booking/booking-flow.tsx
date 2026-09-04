"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { PublicArea, PublicCourse, PublicOption, PublicSlotView } from "@/lib/availability/public-slots";
import type { FeeBreakdown } from "@/domain/booking";
import { weekdayIndex } from "@/domain/availability/shift";
import { SlotTimeline } from "../_components/slot-timeline";
import { getFunnelSessionId } from "../_components/funnel-session";
import {
  confirmBooking,
  fetchBookingSlots,
  fetchTherapistOptions,
  holdSlot,
  releaseHeldSlot,
  trackFunnel,
} from "./actions";

/**
 * 注文フロー（フェーズ11 / spec 6章）。
 * セラピスト → 派遣先（住居/ホテル）→ コース → オプション → 枠選択 →
 * **ホールド（10分・残り時間表示）** → 氏名/電話/住所 → 料金確認 → 確定。
 *
 * - 料金は最後まで隠さない: 常時合計を表示（交通費・深夜加算はホールド時に
 *   サーバが確定した内訳で更新する / spec 6章）
 * - 文言はすべて props（CMS ui_labels 由来）。日本語リテラルを持たない
 * - エラーは Server Action の列挙コード → ラベルに変換（生 DB エラーを出さない）
 * - 空/ローディング/エラーの3状態（spec 12-3）
 */

export interface BookingTherapistItem {
  slug: string;
  name: string;
}

export interface BookingHotelItem {
  id: string;
  name: string;
}

export interface BookingLabels {
  stepTherapist: string;
  stepDestination: string;
  destHome: string;
  destHotel: string;
  hotelSelect: string;
  areaHeading: string;
  areaAll: string;
  stepCourse: string;
  stepOptions: string;
  stepSlot: string;
  slotDateNote: string;
  timelineBooked: string;
  dateHeading: string;
  dateSoonest: string;
  dateTodayLabel: string;
  weekdays: string;
  stepDetails: string;
  nameLabel: string;
  phoneLabel: string;
  addressLabel: string;
  addressHotelLabel: string;
  priceHeading: string;
  priceCourse: string;
  priceOptions: string;
  priceNomination: string;
  priceTransport: string;
  priceMidnight: string;
  priceTotal: string;
  priceProvisionalNote: string;
  holdRemaining: string;
  holdNote: string;
  chooseAnother: string;
  confirmCta: string;
  confirming: string;
  doneTitle: string;
  doneBody: string;
  doneNumber: string;
  emptyTitle: string;
  emptyBody: string;
  loading: string;
  errorGeneric: string;
  errorSlotTaken: string;
  errorSlotGone: string;
  errorHoldExpired: string;
  errorVersion: string;
  errorInvalid: string;
  conditionTemplate: string;
  assumedNote: string;
}

interface HoldState {
  reservationId: string;
  version: number;
  expiresAtISO: string;
  startTime: string;
  dateISO: string;
  fees: FeeBreakdown;
  areaName: string;
}

interface SlotsState {
  slots: PublicSlotView[];
  busy: { startISO: string; endISO: string }[];
  windowStartISO: string | null;
  windowEndISO: string | null;
  areas: PublicArea[];
  areaName: string;
  assumed: boolean;
  dateISO: string;
}

const EMPTY_SLOTS: SlotsState = {
  slots: [],
  busy: [],
  windowStartISO: null,
  windowEndISO: null,
  areas: [],
  areaName: "",
  assumed: true,
  dateISO: "",
};

/** 予約可能な将来日数（当営業日＋この日数先まで選べる） */
const DATE_HORIZON_DAYS = 14;

function addDaysISOLocal(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

function dateLabel(iso: string, weekdays: string, todayLabel: string, today: string): string {
  if (iso === today && todayLabel) return todayLabel;
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const md = `${Number(parts[1])}/${Number(parts[2])}`;
  const wds = weekdays ? weekdays.split(",") : [];
  let wd = "";
  try {
    wd = wds[weekdayIndex(iso)] ?? "";
  } catch {
    wd = "";
  }
  return wd ? `${md}(${wd})` : md;
}

export function BookingFlow({
  therapists,
  hotels,
  courses,
  initialOptions,
  initialSlug,
  today,
  labels,
}: {
  therapists: BookingTherapistItem[];
  hotels: BookingHotelItem[];
  courses: PublicCourse[];
  /** initialSlug のセラピストが対応するオプション（未指定時は空） */
  initialOptions: PublicOption[];
  initialSlug: string | null;
  /** 当営業日 "YYYY-MM-DD"（日付セレクタの起点・本日判定） */
  today: string;
  labels: BookingLabels;
}) {
  const [sessionId, setSessionId] = useState("");
  const [slug, setSlug] = useState<string | null>(initialSlug);
  const [destKind, setDestKind] = useState<"home" | "hotel">("home");
  const [hotelId, setHotelId] = useState<string | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [courseId, setCourseId] = useState<string | null>(courses[0]?.id ?? null);
  const [options, setOptions] = useState<PublicOption[]>(initialOptions);
  const [optionIds, setOptionIds] = useState<string[]>([]);
  // 選択中の日付（"" = 最短でおまかせ＝前方探索）
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [slotsState, setSlotsState] = useState<SlotsState>(EMPTY_SLOTS);
  const [hold, setHold] = useState<HoldState | null>(null);
  const [remainingSec, setRemainingSec] = useState(0);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [addressDetail, setAddressDetail] = useState("");
  const [done, setDone] = useState<{ reservationId: string; totalAmount: number } | null>(null);
  const [errorKey, setErrorKey] = useState<string>("");
  const [pending, startTransition] = useTransition();
  const [confirmPending, startConfirm] = useTransition();
  const requestSeq = useRef(0);

  // 匿名セッション + 訪問イベント（付録B-2）
  useEffect(() => {
    const sid = getFunnelSessionId();
    setSessionId(sid);
    if (sid) void trackFunnel({ sessionId: sid, step: "visit" });
  }, []);

  const errorText = (key: string): string => {
    switch (key) {
      case "slot_taken":
        return labels.errorSlotTaken;
      case "slot_gone":
        return labels.errorSlotGone;
      case "hold_expired":
        return labels.errorHoldExpired;
      case "version_conflict":
        return labels.errorVersion;
      case "invalid":
        return labels.errorInvalid;
      case "generic":
        return labels.errorGeneric;
      default:
        return "";
    }
  };

  const refreshSlots = useCallback(
    (next: {
      slug: string | null;
      areaId: string | null;
      courseId: string | null;
      optionIds: string[];
      hotelId: string | null;
      dateISO?: string;
    }) => {
      if (!next.slug) {
        setSlotsState(EMPTY_SLOTS);
        return;
      }
      const seq = ++requestSeq.current;
      startTransition(async () => {
        try {
          const res = await fetchBookingSlots({
            slug: next.slug,
            // 日付指定ありはその日だけ、"" は前方探索（最短でおまかせ）
            dateISO: next.dateISO || null,
            areaId: next.areaId,
            courseId: next.courseId,
            optionIds: next.optionIds,
            hotelId: next.hotelId,
          });
          if (seq !== requestSeq.current) return;
          if (!res.ok) {
            setErrorKey("generic");
            return;
          }
          setSlotsState({
            slots: res.slots,
            busy: res.busy,
            windowStartISO: res.windowStartISO,
            windowEndISO: res.windowEndISO,
            areas: res.areas,
            areaName: res.areaName,
            assumed: res.assumed,
            dateISO: res.dateISO,
          });
        } catch {
          if (seq === requestSeq.current) setErrorKey("generic");
        }
      });
    },
    [],
  );

  // 初期表示: セラピストが決まっていれば枠を出す
  useEffect(() => {
    refreshSlots({
      slug: initialSlug,
      areaId: null,
      courseId: courses[0]?.id ?? null,
      optionIds: [],
      hotelId: null,
    });
    // 初期化のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ホールドの残り時間（spec 5-5「残り時間を画面に出す」）
  useEffect(() => {
    if (!hold) return;
    const tick = () => {
      const rest = Math.max(
        0,
        Math.floor((Date.parse(hold.expiresAtISO) - Date.now()) / 1000),
      );
      setRemainingSec(rest);
      if (rest === 0) {
        setHold(null);
        setErrorKey("hold_expired");
        refreshSlots({ slug, areaId, courseId, optionIds, hotelId: destKind === "hotel" ? hotelId : null, dateISO: selectedDate });
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [hold, slug, areaId, courseId, optionIds, hotelId, destKind, selectedDate, refreshSlots]);

  // 選べる日付（当営業日 today ＋ 先 DATE_HORIZON_DAYS 日）
  const dateChoices = Array.from({ length: DATE_HORIZON_DAYS + 1 }, (_, i) =>
    addDaysISOLocal(today, i),
  );

  const discardHold = (nextRefresh: boolean) => {
    if (hold && sessionId) {
      void releaseHeldSlot({ reservationId: hold.reservationId, sessionId });
    }
    setHold(null);
    if (nextRefresh) {
      refreshSlots({ slug, areaId, courseId, optionIds, hotelId: destKind === "hotel" ? hotelId : null, dateISO: selectedDate });
    }
  };

  const chooseTherapist = (nextSlug: string) => {
    setSlug(nextSlug);
    setAreaId(null);
    setOptionIds([]);
    setErrorKey("");
    discardHold(false);
    if (sessionId) {
      void trackFunnel({ sessionId, step: "view_therapist", therapistSlug: nextSlug });
    }
    startTransition(async () => {
      try {
        const opts = await fetchTherapistOptions({ slug: nextSlug });
        setOptions(opts);
      } catch {
        setOptions([]);
      }
    });
    refreshSlots({
      slug: nextSlug,
      areaId: null,
      courseId,
      optionIds: [],
      hotelId: destKind === "hotel" ? hotelId : null,
      dateISO: selectedDate,
    });
  };

  const chooseDestKind = (kind: "home" | "hotel") => {
    setDestKind(kind);
    setErrorKey("");
    discardHold(false);
    const nextHotel = kind === "hotel" ? hotelId : null;
    refreshSlots({ slug, areaId: kind === "home" ? areaId : null, courseId, optionIds, hotelId: nextHotel, dateISO: selectedDate });
  };

  const chooseHotel = (id: string | null) => {
    setHotelId(id);
    setErrorKey("");
    discardHold(false);
    refreshSlots({ slug, areaId: null, courseId, optionIds, hotelId: id, dateISO: selectedDate });
  };

  const chooseArea = (id: string | null) => {
    setAreaId(id);
    setErrorKey("");
    discardHold(false);
    refreshSlots({ slug, areaId: id, courseId, optionIds, hotelId: destKind === "hotel" ? hotelId : null, dateISO: selectedDate });
  };

  const chooseCourse = (id: string) => {
    setCourseId(id);
    setErrorKey("");
    discardHold(false);
    refreshSlots({ slug, areaId, courseId: id, optionIds, hotelId: destKind === "hotel" ? hotelId : null, dateISO: selectedDate });
  };

  const chooseDate = (iso: string) => {
    setSelectedDate(iso);
    setErrorKey("");
    discardHold(false);
    refreshSlots({ slug, areaId, courseId, optionIds, hotelId: destKind === "hotel" ? hotelId : null, dateISO: iso });
  };

  const toggleOption = (id: string) => {
    const next = optionIds.includes(id)
      ? optionIds.filter((o) => o !== id)
      : [...optionIds, id];
    setOptionIds(next);
    setErrorKey("");
    discardHold(false);
    refreshSlots({ slug, areaId, courseId, optionIds: next, hotelId: destKind === "hotel" ? hotelId : null, dateISO: selectedDate });
  };

  const chooseSlot = (slot: PublicSlotView) => {
    if (!slug || !courseId || !sessionId || !slotsState.dateISO) return;
    setErrorKey("");
    void trackFunnel({
      sessionId,
      step: "select_slot",
      therapistSlug: slug,
      meta: { startAt: slot.startAtISO },
    });
    startTransition(async () => {
      try {
        const res = await holdSlot({
          slug,
          dateISO: slotsState.dateISO,
          startAtISO: slot.startAtISO,
          areaId: destKind === "home" ? areaId : null,
          courseId,
          optionIds,
          hotelId: destKind === "hotel" ? hotelId : null,
          sessionId,
        });
        if (!res.ok) {
          setErrorKey(res.error);
          refreshSlots({ slug, areaId, courseId, optionIds, hotelId: destKind === "hotel" ? hotelId : null, dateISO: selectedDate });
          return;
        }
        setHold({
          reservationId: res.reservationId,
          version: res.version,
          expiresAtISO: res.expiresAtISO,
          startTime: slot.time,
          dateISO: slotsState.dateISO,
          fees: res.fees,
          areaName: res.areaName,
        });
      } catch {
        setErrorKey("generic");
      }
    });
  };

  const submitConfirm = () => {
    if (!hold || !sessionId) return;
    setErrorKey("");
    startConfirm(async () => {
      try {
        const res = await confirmBooking({
          reservationId: hold.reservationId,
          sessionId,
          version: hold.version,
          customerName,
          customerPhone,
          addressDetail,
          addressLabel: null,
        });
        if (!res.ok) {
          setErrorKey(res.error);
          if (res.error === "hold_expired" || res.error === "hold_not_found") {
            setHold(null);
            refreshSlots({ slug, areaId, courseId, optionIds, hotelId: destKind === "hotel" ? hotelId : null, dateISO: selectedDate });
          }
          return;
        }
        setDone({ reservationId: res.reservationId, totalAmount: res.totalAmount });
        setHold(null);
      } catch {
        setErrorKey("generic");
      }
    });
  };

  const selectedCourse = courses.find((c) => c.id === courseId) ?? null;
  const selectedOptions = options.filter((o) => optionIds.includes(o.id));

  // 料金の常時表示（spec 6章「料金は最後まで隠さない」）。
  // ホールド前は交通費・深夜加算が未確定（サーバがホールド時に確定する）
  const provisionalFees: FeeBreakdown | null = useMemo(() => {
    if (hold) return hold.fees;
    if (!selectedCourse) return null;
    const optionsTotal = selectedOptions.reduce((sum, o) => sum + o.price, 0);
    const nomination = selectedCourse.nominationFeeDefault;
    return {
      coursePrice: selectedCourse.price,
      optionsTotal,
      nominationFee: nomination,
      transportFee: 0,
      midnightSurcharge: 0,
      totalAmount: selectedCourse.price + optionsTotal + nomination,
    };
  }, [hold, selectedCourse, selectedOptions]);

  const condition =
    slotsState.areaName && labels.conditionTemplate
      ? labels.conditionTemplate.replace("{area}", slotsState.areaName)
      : "";

  const dateNote = (() => {
    if (!slotsState.dateISO || !labels.slotDateNote) return "";
    const parts = slotsState.dateISO.split("-");
    const md = parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : slotsState.dateISO;
    return labels.slotDateNote.replace("{date}", md);
  })();

  const yen = (v: number): string => `¥${v.toLocaleString("en-US")}`;
  const mmss = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  const activeError = errorText(errorKey);

  // 完了画面（spec 6章 手順10〜11）
  if (done) {
    return (
      <div className="mx-auto max-w-md space-y-4 rounded border border-pub-border bg-pub-surface p-6 text-center">
        {labels.doneTitle && (
          <h2 className="font-heading text-xl text-pub-primary">{labels.doneTitle}</h2>
        )}
        {labels.doneNumber && (
          <p className="text-sm text-pub-subtext">
            {labels.doneNumber}
            <span className="ml-2 font-mono text-base text-pub-text">
              {done.reservationId.slice(0, 8).toUpperCase()}
            </span>
          </p>
        )}
        <p className="font-mono text-2xl tabular-nums text-pub-primary">
          {yen(done.totalAmount)}
        </p>
        {labels.doneBody && <p className="text-sm text-pub-subtext">{labels.doneBody}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-28">
      {/* 1. セラピスト（spec 6章 手順1） */}
      <section aria-label={labels.stepTherapist || undefined}>
        {labels.stepTherapist && (
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
            {labels.stepTherapist}
          </h2>
        )}
        <div className="flex flex-wrap gap-2" role="group" aria-label={labels.stepTherapist || undefined}>
          {therapists.map((t) => (
            <button
              key={t.slug}
              type="button"
              onClick={() => chooseTherapist(t.slug)}
              aria-pressed={slug === t.slug}
              className={chipClass(slug === t.slug)}
            >
              {t.name || t.slug}
            </button>
          ))}
        </div>
      </section>

      {/* 2. 派遣先（住居 / ホテル）→ エリア（spec 6章 手順2） */}
      <section aria-label={labels.stepDestination || undefined}>
        {labels.stepDestination && (
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
            {labels.stepDestination}
          </h2>
        )}
        <div className="flex flex-wrap gap-2">
          {labels.destHome && (
            <button
              type="button"
              onClick={() => chooseDestKind("home")}
              aria-pressed={destKind === "home"}
              className={chipClass(destKind === "home")}
            >
              {labels.destHome}
            </button>
          )}
          {labels.destHotel && hotels.length > 0 && (
            <button
              type="button"
              onClick={() => chooseDestKind("hotel")}
              aria-pressed={destKind === "hotel"}
              className={chipClass(destKind === "hotel")}
            >
              {labels.destHotel}
            </button>
          )}
        </div>

        {destKind === "hotel" && (
          <div className="mt-3">
            <label className="mb-1 block text-xs text-pub-subtext" htmlFor="booking-hotel">
              {labels.hotelSelect}
            </label>
            <select
              id="booking-hotel"
              value={hotelId ?? ""}
              onChange={(e) => chooseHotel(e.target.value || null)}
              className="w-full rounded border border-pub-border bg-pub-surface px-3 py-2 text-sm text-pub-text [color-scheme:dark]"
            >
              {/* option に明示背景色（スマホの透明背景で見えなくなるのを防ぐ） */}
              <option value="" style={{ backgroundColor: "#1E252D", color: "#EDE9E2" }} />
              {hotels.map((h) => (
                <option key={h.id} value={h.id} style={{ backgroundColor: "#1E252D", color: "#EDE9E2" }}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {destKind === "home" && slotsState.areas.length > 0 && (
          <div className="mt-3">
            {labels.areaHeading && (
              <h3 className="mb-2 text-xs text-pub-subtext">{labels.areaHeading}</h3>
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
              {slotsState.areas.map((a) => (
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
          </div>
        )}
      </section>

      {/* 3. コース（spec 6章 手順3） */}
      <section aria-label={labels.stepCourse || undefined}>
        {labels.stepCourse && (
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
            {labels.stepCourse}
          </h2>
        )}
        <div className="flex flex-wrap gap-2" role="group" aria-label={labels.stepCourse || undefined}>
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
                {yen(c.price)}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* 4. オプション（時間が伸びると枠を再確認 / spec 6章 手順7） */}
      {options.length > 0 && (
        <section aria-label={labels.stepOptions || undefined}>
          {labels.stepOptions && (
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
              {labels.stepOptions}
            </h2>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label={labels.stepOptions || undefined}>
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
                  <span className="ml-2 font-mono text-xs tabular-nums opacity-80">
                    {yen(o.price)}
                  </span>
                  {o.durationMin > 0 && (
                    <span className="ml-1 font-mono text-xs tabular-nums opacity-80">
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

      {/* 5. 日付選択（当営業日＋将来日／最短でおまかせ） */}
      {slug && (
        <section aria-label={labels.dateHeading || undefined}>
          {labels.dateHeading && (
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-pub-subtext">
              {labels.dateHeading}
            </h2>
          )}
          <select
            value={selectedDate}
            onChange={(e) => chooseDate(e.target.value)}
            aria-label={labels.dateHeading || undefined}
            className="w-full rounded border border-pub-border bg-pub-surface px-3 py-2 text-sm text-pub-text [color-scheme:dark]"
          >
            {labels.dateSoonest && (
              <option value="" style={{ backgroundColor: "#1E252D", color: "#EDE9E2" }}>
                {labels.dateSoonest}
              </option>
            )}
            {dateChoices.map((iso) => (
              <option key={iso} value={iso} style={{ backgroundColor: "#1E252D", color: "#EDE9E2" }}>
                {dateLabel(iso, labels.weekdays, labels.dateTodayLabel, today)}
              </option>
            ))}
          </select>
        </section>
      )}

      {/* 6. 枠選択 → ホールド（spec 6章 手順4 / 5-5） */}
      <section aria-label={labels.stepSlot || undefined} aria-busy={pending}>
        <div className="mb-2 flex items-center justify-between gap-2">
          {labels.stepSlot && (
            <h2 className="text-xs font-medium uppercase tracking-wide text-pub-subtext">
              {labels.stepSlot}
            </h2>
          )}
          {pending && labels.loading && (
            <span className="text-xs text-pub-subtext" role="status">
              {labels.loading}
            </span>
          )}
        </div>

        {condition && (
          <p className="mb-1 text-sm text-pub-subtext">
            {condition}
            {slotsState.assumed && labels.assumedNote && (
              <span className="ml-1 text-xs text-pub-subtext/80">{labels.assumedNote}</span>
            )}
          </p>
        )}
        {dateNote && (
          <p className="mb-2 text-xs font-medium text-pub-primary">{dateNote}</p>
        )}

        {activeError && (
          <p
            className="mb-3 rounded border border-pub-primary/60 bg-pub-surface px-4 py-3 text-sm text-pub-text"
            role="alert"
          >
            {activeError}
          </p>
        )}

        {/* 縦タイムライン（視覚的な空き枠。タップでその枠をホールド） */}
        {hold === null && slotsState.windowStartISO && (
          <div className="mb-3">
            <SlotTimeline
              slots={slotsState.slots}
              busy={slotsState.busy}
              windowStartISO={slotsState.windowStartISO}
              windowEndISO={slotsState.windowEndISO}
              onPick={chooseSlot}
              labels={{ booked: labels.timelineBooked }}
              pending={pending}
            />
          </div>
        )}

        {hold === null &&
          (slotsState.slots.length === 0 ? (
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
              {slotsState.slots.map((s) => (
                <li key={s.startAtISO}>
                  <button
                    type="button"
                    onClick={() => chooseSlot(s)}
                    disabled={pending}
                    className="inline-block rounded border border-pub-primary/50 bg-pub-primary/10 px-3 py-1.5 font-mono text-base font-medium tabular-nums text-pub-primary transition-colors hover:bg-pub-primary hover:text-pub-bg focus-visible:bg-pub-primary focus-visible:text-pub-bg"
                  >
                    {s.time}
                  </button>
                </li>
              ))}
            </ul>
          ))}

        {/* ホールド中: 残り時間 + 入力フォーム（spec 5-5「残り時間を画面に出す」/ 6章 手順5〜6） */}
        {hold && (
          <div className="space-y-4 rounded border border-pub-primary/40 bg-pub-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-lg tabular-nums text-pub-primary">
                {hold.startTime}
              </p>
              <p className="text-sm text-pub-subtext">
                {labels.holdRemaining}
                <span
                  className="ml-2 font-mono text-lg font-semibold tabular-nums text-pub-primary"
                  role="timer"
                >
                  {mmss(remainingSec)}
                </span>
              </p>
            </div>
            {labels.holdNote && (
              <p className="text-xs text-pub-subtext">{labels.holdNote}</p>
            )}

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-pub-subtext" htmlFor="booking-name">
                  {labels.nameLabel}
                </label>
                <input
                  id="booking-name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  autoComplete="name"
                  className="w-full rounded border border-pub-border bg-pub-bg px-3 py-2 text-sm text-pub-text"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-pub-subtext" htmlFor="booking-phone">
                  {labels.phoneLabel}
                </label>
                <input
                  id="booking-phone"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ""))}
                  inputMode="tel"
                  autoComplete="tel"
                  className="w-full rounded border border-pub-border bg-pub-bg px-3 py-2 font-mono text-sm text-pub-text"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-pub-subtext" htmlFor="booking-address">
                  {destKind === "hotel" ? labels.addressHotelLabel : labels.addressLabel}
                </label>
                <textarea
                  id="booking-address"
                  value={addressDetail}
                  onChange={(e) => setAddressDetail(e.target.value)}
                  rows={2}
                  autoComplete="street-address"
                  className="w-full rounded border border-pub-border bg-pub-bg px-3 py-2 text-sm text-pub-text"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              {labels.chooseAnother && (
                <button
                  type="button"
                  onClick={() => discardHold(true)}
                  className="text-xs text-pub-subtext underline hover:text-pub-text"
                >
                  {labels.chooseAnother}
                </button>
              )}
              <button
                type="button"
                onClick={submitConfirm}
                disabled={
                  confirmPending ||
                  customerName.trim() === "" ||
                  !/^0[0-9]{9,10}$/.test(customerPhone) ||
                  addressDetail.trim() === ""
                }
                className="rounded bg-pub-primary px-6 py-2.5 text-sm font-medium text-pub-bg transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {confirmPending && labels.confirming ? labels.confirming : labels.confirmCta}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 料金の常時表示（spec 6章「料金は最後まで隠さない」） */}
      {provisionalFees && (
        <aside
          className="fixed inset-x-0 bottom-0 border-t border-pub-border bg-pub-surface/95 px-5 py-3 backdrop-blur"
          aria-label={labels.priceHeading || undefined}
        >
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-pub-subtext">
              {labels.priceCourse && (
                <span>
                  {labels.priceCourse}{" "}
                  <span className="font-mono tabular-nums">{yen(provisionalFees.coursePrice)}</span>
                </span>
              )}
              {provisionalFees.optionsTotal > 0 && labels.priceOptions && (
                <span>
                  {labels.priceOptions}{" "}
                  <span className="font-mono tabular-nums">{yen(provisionalFees.optionsTotal)}</span>
                </span>
              )}
              {provisionalFees.nominationFee > 0 && labels.priceNomination && (
                <span>
                  {labels.priceNomination}{" "}
                  <span className="font-mono tabular-nums">{yen(provisionalFees.nominationFee)}</span>
                </span>
              )}
              {provisionalFees.transportFee > 0 && labels.priceTransport && (
                <span>
                  {labels.priceTransport}{" "}
                  <span className="font-mono tabular-nums">{yen(provisionalFees.transportFee)}</span>
                </span>
              )}
              {provisionalFees.midnightSurcharge > 0 && labels.priceMidnight && (
                <span>
                  {labels.priceMidnight}{" "}
                  <span className="font-mono tabular-nums">{yen(provisionalFees.midnightSurcharge)}</span>
                </span>
              )}
              {!hold && labels.priceProvisionalNote && (
                <span className="opacity-70">{labels.priceProvisionalNote}</span>
              )}
            </div>
            <p className="shrink-0 text-right">
              {labels.priceTotal && (
                <span className="mr-2 text-xs text-pub-subtext">{labels.priceTotal}</span>
              )}
              <span className="font-mono text-xl font-semibold tabular-nums text-pub-primary">
                {yen(provisionalFees.totalAmount)}
              </span>
            </p>
          </div>
        </aside>
      )}
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
