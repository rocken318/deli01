import type { Metadata } from "next";
import { getSiteContext, label } from "@/lib/public/content";
import { listPublicTherapists } from "@/lib/public/queries";
import {
  getPublicTherapistId,
  listPublicCourses,
  listPublicOptions,
} from "@/lib/availability/public-slots";
import { listBookableHotels } from "@/lib/booking/catalog";
import { operatingDayISO } from "@/domain/availability";
import { BookingFlow } from "./booking-flow";
import type { BookingLabels, BookingTherapistItem } from "./booking-flow";
import { EmptyState } from "../_components/empty-state";

/**
 * 注文画面（フェーズ11 / spec 6章）。
 * セラピスト → 派遣先 → コース → 枠 → ホールド(10分) → 入力 → 確定。
 * 文言はすべて CMS（ui_labels）経由。?t=slug でセラピストを事前選択できる
 * （個人ページの枠から遷移）。
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await getSiteContext();
  return { title: label(ctx, "booking_page_title") || ctx.brandName || " " };
}

export default async function BookingPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const [ctx, therapistsRaw, courses, hotels, params] = await Promise.all([
    getSiteContext(),
    listPublicTherapists(),
    listPublicCourses(),
    listBookableHotels(),
    searchParams,
  ]);

  const therapists: BookingTherapistItem[] = therapistsRaw.map((t) => ({
    slug: t.slug,
    name: typeof t.published["name"] === "string" ? (t.published["name"] as string) : t.slug,
  }));

  const initialSlug =
    params.t && therapists.some((t) => t.slug === params.t) ? params.t : null;
  const initialTherapistId = initialSlug ? await getPublicTherapistId(initialSlug) : null;
  const initialOptions = initialTherapistId ? await listPublicOptions(initialTherapistId) : [];

  const labels: BookingLabels = {
    stepTherapist: label(ctx, "booking_step_therapist"),
    stepDestination: label(ctx, "booking_step_destination"),
    destHome: label(ctx, "booking_dest_home"),
    destHotel: label(ctx, "booking_dest_hotel"),
    hotelSelect: label(ctx, "booking_hotel_select"),
    areaHeading: label(ctx, "slots_area_heading"),
    areaAll: label(ctx, "slots_area_all"),
    stepCourse: label(ctx, "slots_course_heading"),
    stepOptions: label(ctx, "slots_option_heading"),
    stepSlot: label(ctx, "booking_step_slot"),
    slotDateNote: label(ctx, "slots_date_note"),
    stepDetails: label(ctx, "booking_step_details"),
    nameLabel: label(ctx, "booking_name_label"),
    phoneLabel: label(ctx, "booking_phone_label"),
    addressLabel: label(ctx, "booking_address_label"),
    addressHotelLabel: label(ctx, "booking_address_hotel_label"),
    priceHeading: label(ctx, "booking_price_heading"),
    priceCourse: label(ctx, "booking_price_course"),
    priceOptions: label(ctx, "booking_price_options"),
    priceNomination: label(ctx, "booking_price_nomination"),
    priceTransport: label(ctx, "booking_price_transport"),
    priceMidnight: label(ctx, "booking_price_midnight"),
    priceTotal: label(ctx, "booking_price_total"),
    priceProvisionalNote: label(ctx, "booking_price_provisional_note"),
    holdRemaining: label(ctx, "booking_hold_remaining"),
    holdNote: label(ctx, "booking_hold_note"),
    chooseAnother: label(ctx, "booking_choose_another"),
    confirmCta: label(ctx, "booking_confirm_cta"),
    confirming: label(ctx, "booking_confirming"),
    doneTitle: label(ctx, "booking_done_title"),
    doneBody: label(ctx, "booking_done_body"),
    doneNumber: label(ctx, "booking_done_number"),
    emptyTitle: label(ctx, "slots_empty_title"),
    emptyBody: label(ctx, "slots_empty_body"),
    loading: label(ctx, "slots_loading"),
    errorGeneric: label(ctx, "booking_error_generic"),
    errorSlotTaken: label(ctx, "booking_error_slot_taken"),
    errorSlotGone: label(ctx, "booking_error_slot_gone"),
    errorHoldExpired: label(ctx, "booking_error_hold_expired"),
    errorVersion: label(ctx, "booking_error_version"),
    errorInvalid: label(ctx, "booking_error_invalid"),
    conditionTemplate: label(ctx, "slots_condition_template"),
    assumedNote: label(ctx, "slots_assumed_note"),
    dateHeading: label(ctx, "slots_date_heading"),
    dateSoonest: label(ctx, "slots_date_soonest"),
    dateTodayLabel: label(ctx, "slots_date_today"),
    weekdays: label(ctx, "schedule_weekdays"),
  };

  const today = operatingDayISO(new Date());

  const heading = label(ctx, "booking_page_title");

  if (therapists.length === 0 || courses.length === 0) {
    return (
      <div className="py-8">
        <EmptyState
          title={label(ctx, "booking_pending_title")}
          body={label(ctx, "booking_pending_body")}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      {heading && (
        <h1 className="mb-6 font-heading text-2xl text-pub-text">{heading}</h1>
      )}
      <BookingFlow
        therapists={therapists}
        hotels={hotels}
        courses={courses}
        initialOptions={initialOptions}
        initialSlug={initialSlug}
        today={today}
        labels={labels}
      />
    </div>
  );
}
